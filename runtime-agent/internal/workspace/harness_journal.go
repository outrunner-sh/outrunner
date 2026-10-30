package workspace

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// HarnessState is the selection and durable continuation of a logical chat.
// Credentials never enter the journal or this descriptor.
type HarnessState struct {
	ID        string          `json:"id"`
	Agent     string          `json:"agent"`
	From      string          `json:"from"`
	Selection json.RawMessage `json:"selection"`
	Prompt    string          `json:"prompt,omitempty"`
	Delivered bool            `json:"delivered"`
	Saved     bool            `json:"saved"`
	Mode      string          `json:"mode,omitempty"`
}

type journalRecord struct {
	Type    string        `json:"type"`
	Harness *HarnessState `json:"outrunnerHarness,omitempty"`
	Segment string        `json:"outrunnerSegment,omitempty"`
	Offset  int64         `json:"outrunnerOffset,omitempty"`
}

type journalCopy struct {
	Segment string
	Offset  int64
}

func copyConversation(source, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	out, err := os.CreateTemp(filepath.Dir(dest), "conversation-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	if source != "" {
		in, err := os.Open(source)
		if err != nil {
			return err
		}
		defer in.Close()
		if _, err := io.Copy(out, in); err != nil {
			return err
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(out.Name(), dest)
}

func (s *Service) journalPath(id string) string {
	return filepath.Join(s.Root, "harness-history", id+".jsonl")
}

// The original log is a byte-for-byte prefix: existing cursors stay valid.
// Copied native records carry their source offset for restart-safe deduplication.
func (s *Service) harnessLog(id string) string {
	s.journalMu.Lock()
	defer s.journalMu.Unlock()
	_ = s.syncHarnessLog(id) // retried by the next watcher poll
	return s.journalPath(id)
}

func (s *Service) flushHarnessJournal(id string) error {
	s.journalMu.Lock()
	defer s.journalMu.Unlock()
	return s.syncHarnessLog(id)
}

func journalHasOperation(path, operation string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return false
		}
		var rec journalRecord
		if json.Unmarshal(line, &rec) == nil && rec.Harness != nil && rec.Harness.ID == operation {
			return true
		}
	}
}

func (s *Service) syncHarnessLog(id string) error {
	if _, err := os.Stat(s.harnessUndoPath(id)); err == nil {
		return nil
	}
	f, _ := s.getFacts(id)
	if f.Harness == nil {
		return nil
	}
	path := s.nativeLog(id)
	if path == "" {
		return nil
	}
	if s.journalCopies == nil {
		s.journalCopies = map[string]journalCopy{}
	}
	copyState, found := s.journalCopies[id]
	if !found || copyState.Segment != f.Harness.ID {
		_, offset, err := journalState(s.journalPath(id), f.Harness.ID)
		if err != nil {
			return err
		}
		copyState = journalCopy{Segment: f.Harness.ID, Offset: offset}
	}
	offset := copyState.Offset
	native, err := os.Open(path)
	if err != nil {
		return err
	}
	defer native.Close()
	if _, err := native.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReader(native)
	var out bytes.Buffer
	commitOffset := offset
	flush := func() error {
		if out.Len() == 0 {
			return nil
		}
		if err := appendRecords(s.journalPath(id), out.Bytes()); err != nil {
			return err
		}
		s.journalCopies[id] = journalCopy{Segment: f.Harness.ID, Offset: commitOffset}
		out.Reset()
		return nil
	}
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		offset += int64(len(line))
		var rec map[string]json.RawMessage
		if json.Unmarshal(line, &rec) != nil || rec == nil {
			continue
		}
		rec["outrunnerSegment"], _ = json.Marshal(f.Harness.ID)
		rec["outrunnerOffset"], _ = json.Marshal(offset)
		encoded, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		out.Write(encoded)
		out.WriteByte('\n')
		commitOffset = offset
		if out.Len() >= 1<<20 {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	return flush()
}

// Internal state records are ignored by the conversation decoder.
func journalState(path, segment string) (*HarnessState, int64, error) {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	var state *HarnessState
	var offset int64
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, 0, err
		}
		var rec journalRecord
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		if rec.Harness != nil {
			state = rec.Harness
		}
		if rec.Segment == segment {
			offset = rec.Offset
		}
	}
	return state, offset, nil
}

func (s *Service) writeHarnessState(id string, state *HarnessState, boundary bool) error {
	type record struct {
		Type    string        `json:"type"`
		UUID    string        `json:"uuid,omitempty"`
		Harness *HarnessState `json:"outrunnerHarness"`
	}
	kind := "outrunner_harness_state"
	if boundary {
		kind = "outrunner_harness_switch"
	}
	line, err := json.Marshal(record{kind, "harness-" + state.ID, state})
	if err != nil {
		return err
	}
	return appendRecords(s.journalPath(id), append(line, '\n'))
}

// Split the portable journal from the log its current vendor resumes. A vendor
// never loads another vendor's historical records into its native session.
func (s *Service) restoreHarnessJournal(id, downloaded string) error {
	state, _, err := journalState(downloaded, "")
	if err != nil || state == nil {
		return err
	}
	s.journalMu.Lock()
	delete(s.journalCopies, id)
	s.journalMu.Unlock()
	if err := copyConversation(downloaded, s.journalPath(id)); err != nil {
		return err
	}
	journal, err := os.Open(s.journalPath(id))
	if err != nil {
		return err
	}
	defer journal.Close()
	active, err := os.CreateTemp(filepath.Dir(downloaded), "active-*.tmp")
	if err != nil {
		return err
	}
	defer active.Close()
	defer os.Remove(active.Name())
	var activeSize int64
	writer := bufio.NewWriter(active)
	reader := bufio.NewReader(journal)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		var rec journalRecord
		if json.Unmarshal(line, &rec) == nil && rec.Segment == state.ID && rec.Type != "outrunner_checkpoint" {
			var raw map[string]json.RawMessage
			if err := json.Unmarshal(line, &raw); err != nil {
				return err
			}
			delete(raw, "outrunnerSegment")
			delete(raw, "outrunnerOffset")
			b, _ := json.Marshal(raw)
			n, err := writer.Write(append(b, '\n'))
			if err != nil {
				return err
			}
			activeSize += int64(n)
		}
	}
	if state.Agent != AgentClaude && state.Agent != AgentCodex {
		return fmt.Errorf("invalid archived harness")
	}
	f, _ := s.getFacts(id)
	if agentOrClaude(f.Agent) != state.Agent {
		return fmt.Errorf("the archived harness differs from the recorded selection")
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	if err := active.Close(); err != nil {
		return err
	}
	if err := os.Rename(active.Name(), downloaded); err != nil {
		return err
	}
	if activeSize == 0 && state.Agent == AgentClaude {
		if err := os.Remove(downloaded); err != nil {
			return err
		}
	}
	// Rebase the copy checkpoint without changing native session identity.
	s.updateFacts(id, func(f *workspaceFacts) {
		f.Harness = state
		if state.Agent == AgentClaude {
			f.ClaudeSessionID = strings.TrimSuffix(filepath.Base(downloaded), filepath.Ext(downloaded))
		}
	})
	if err := s.writeHarnessState(id, state, false); err != nil {
		return err
	}
	checkpoint, _ := json.Marshal(journalRecord{Type: "outrunner_checkpoint", Segment: state.ID, Offset: activeSize})
	if err := appendRecords(s.journalPath(id), append(checkpoint, '\n')); err != nil {
		return err
	}
	handoff, err := s.handoff(s.owner(id), "switch-"+state.ID, id, "this conversation", false)
	if err != nil {
		return err
	}
	if !state.Delivered {
		handoff += handoffOpen + "\nContinuation operation: " + state.ID + "\n" + handoffClose + "\n\n"
		s.updateFacts(id, func(f *workspaceFacts) { f.Handoff = handoff })
	}
	return nil
}

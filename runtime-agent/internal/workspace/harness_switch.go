package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

var ErrHarnessConflict = errors.New("the chat changed or a harness continuation is pending; retry the original switch")

type HarnessInput struct {
	ID, Agent, ExpectedAgent string
	Mode                     string
	Selection                json.RawMessage
	Model                    ModelChoice
	Auth                     protocol.SetAuthRequest
	Prompt                   string
	Resume                   bool
}

// A private undo record is written before changing the native session. A
// process crash before commit restores this selection on the next Start/send.
// Its credential material never appears in the transcript or HTTP responses.
type harnessUndo struct {
	Facts         workspaceFacts `json:"facts"`
	Auth, Gateway string
	JournalSize   int64
	NativeBackup  string
}

func (s *Service) harnessUndoPath(id string) string {
	return filepath.Join(s.Root, "harness-undo", id+".json")
}

func (s *Service) persistFacts(id string, f workspaceFacts) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if err := writeKeysFile(s.factsPath(id), string(data)); err != nil {
		return err
	}
	s.mu.Lock()
	s.facts[id] = f
	s.mu.Unlock()
	return nil
}

// HarnessSelection recovers a half-prepared transition before reporting the
// selected harness. The runtime is authoritative after a lost HTTP response.
func (s *Service) HarnessSelection(ctx context.Context, id string) (*HarnessState, error) {
	defer s.lockLifecycle(id)()
	lock := s.lockSend(id)
	defer lock.Unlock()
	if err := s.recoverHarnessHeld(ctx, id); err != nil {
		return nil, err
	}
	f, ok := s.getFacts(id)
	if !ok {
		return nil, ErrUnknownWorkspace
	}
	if f.Harness == nil {
		return nil, nil
	}
	state := *f.Harness
	state.Mode = ModeBuild
	if f.Plan {
		state.Mode = ModePlan
	}
	return &state, nil
}

// The control plane acknowledges only after its checked database write. An
// unacknowledged selection cannot be archived or superseded by another switch.
func (s *Service) AcknowledgeHarness(ctx context.Context, id, operation string) (*HarnessState, error) {
	defer s.lockLifecycle(id)()
	lock := s.lockSend(id)
	defer lock.Unlock()
	if err := s.recoverHarnessHeld(ctx, id); err != nil {
		return nil, err
	}
	f, _ := s.getFacts(id)
	if f.Harness == nil || f.Harness.ID != operation {
		return nil, ErrHarnessConflict
	}
	state := *f.Harness
	state.Saved = true
	s.journalMu.Lock()
	err := s.writeHarnessState(id, &state, false)
	s.journalMu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := s.persistHarnessState(id, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (s *Service) recoverHarnessHeld(ctx context.Context, id string) error {
	data, err := os.ReadFile(s.harnessUndoPath(id))
	if os.IsNotExist(err) {
		f, ok := s.getFacts(id)
		if ok && f.Harness != nil && (!f.Harness.Delivered || !f.Harness.Saved) {
			state, _, readErr := journalState(s.journalPath(id), "")
			if readErr != nil {
				return readErr
			}
			if state != nil && state.ID == f.Harness.ID && (state.Delivered != f.Harness.Delivered || state.Saved != f.Harness.Saved) {
				return s.persistHarnessState(id, state)
			}
		}
		return nil
	}
	if err != nil {
		return err
	}
	var undo harnessUndo
	if err := json.Unmarshal(data, &undo); err != nil {
		return err
	}
	// A committed boundary means the target owns the chat. Otherwise restore
	// the source, even if the process died after starting the target's TUI.
	state, _, err := journalState(s.journalPath(id), "")
	if err != nil {
		return err
	}
	current, _ := s.getFacts(id)
	if current.Harness != nil && state != nil && state.ID == current.Harness.ID &&
		(undo.Facts.Harness == nil || state.ID != undo.Facts.Harness.ID) {
		return os.Remove(s.harnessUndoPath(id))
	}
	s.endSummary(id)
	if err := s.tmux.KillSession(ctx, sessionName(id)); err != nil {
		return err
	}
	if err := s.authFiles().put(id, undo.Auth); err != nil {
		return err
	}
	if err := s.gatewayFiles().put(id, undo.Gateway); err != nil {
		return err
	}
	if undo.NativeBackup != "" {
		if err := os.Rename(undo.NativeBackup, conversationPath(s.Root, id)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Truncate(s.journalPath(id), undo.JournalSize); err != nil {
		return err
	}
	if err := s.persistFacts(id, undo.Facts); err != nil {
		return err
	}
	return os.Remove(s.harnessUndoPath(id))
}

// SwitchHarness keeps the runtime/chat address stable. Lifecycle and send locks
// cover the stop, handoff, native launch and first delivery, so Mission/Slack
// sends cannot land on the old harness after it has been stopped.
func (s *Service) SwitchHarness(ctx context.Context, id string, in HarnessInput) (*HarnessState, error) {
	if s.jcode != nil {
		return nil, ErrChatsUnsupported
	}
	defer s.lockLifecycle(id)()
	lock := s.lockSend(id)
	defer lock.Unlock()
	base, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*switchRelaunchTimeout)
	defer cancel()
	if err := s.recoverHarnessHeld(base, id); err != nil {
		return nil, err
	}
	f, ok := s.getFacts(id)
	if !ok {
		return nil, ErrUnknownWorkspace
	}
	if f.Harness != nil && f.Harness.ID == in.ID {
		if f.Agent != in.Agent {
			return nil, ErrHarnessConflict
		}
		return s.finishHarnessHeld(base, id, lock)
	}
	if f.Harness != nil && (!f.Harness.Delivered || !f.Harness.Saved) {
		return nil, ErrHarnessConflict
	}
	if journalHasOperation(s.journalPath(id), in.ID) {
		return nil, ErrHarnessConflict
	}
	if agentOrClaude(f.Agent) != in.ExpectedAgent || in.Agent == in.ExpectedAgent {
		return nil, ErrHarnessConflict
	}
	if err := s.CheckAgent(in.Agent); err != nil {
		return nil, err
	}
	if in.Agent == AgentCodex {
		if _, err := s.lookPath("codex"); err != nil {
			return nil, ErrCodexMissing
		}
		if in.Model.Gateway != claude.NoGateway && !codexGateway(in.Model.Gateway) {
			return nil, ErrGatewayUnsupported
		}
	}
	if in.Auth.Kind != AuthNone && authAgent[in.Auth.Kind] != in.Agent {
		return nil, ErrAuthMismatch
	}
	if s.awaitingAnswer(base, id, sessionName(id)) {
		return nil, errAwaitsAnswer
	}
	if in.Resume {
		prompt, err := s.resumeRequest(id)
		if err != nil {
			return nil, err
		}
		in.Prompt = prompt
	}
	if strings.TrimSpace(in.Prompt) == "" {
		return nil, errors.New("a harness switch needs a message or an unfinished request")
	}
	if err := s.interruptHeld(base, id); err != nil {
		return nil, err
	}
	// Flush the source before freezing its history. Native sessions retain
	// their own log and vendor IDs; only the public stream is concatenated.
	s.endSummary(id)
	f, _ = s.getFacts(id)
	if err := s.flushHarnessJournal(id); err != nil {
		return nil, err
	}
	sourceLog := s.SessionLog(id)
	s.journalMu.Lock()
	if f.Harness == nil {
		if err := copyConversation(sourceLog, s.journalPath(id)); err != nil {
			s.journalMu.Unlock()
			return nil, err
		}
	}
	info, err := os.Stat(s.journalPath(id))
	s.journalMu.Unlock()
	if err != nil {
		return nil, err
	}
	handoff, err := s.handoff(s.owner(id), "switch-"+in.ID, id, "this conversation", false)
	if err != nil {
		return nil, err
	}
	// Source readers used native history before the first switch. Future
	// handoffs always reference the portable full journal instead.
	if sourceLog != "" {
		handoff = strings.ReplaceAll(handoff, sourceLog, s.journalPath(id))
	}
	handoff += handoffOpen + "\nContinuation operation: " + in.ID + "\n" + handoffClose + "\n\n"
	undo := harnessUndo{Facts: f, Auth: s.authFiles().read(id), Gateway: s.gatewayFiles().read(id), JournalSize: info.Size()}
	if f.Agent == AgentCodex {
		undo.NativeBackup = conversationPath(s.Root, id) + ".segment-" + in.ID
	}
	data, _ := json.Marshal(undo)
	if err := writeKeysFile(s.harnessUndoPath(id), string(data)); err != nil {
		return nil, err
	}
	rollback := func(cause error) (*HarnessState, error) {
		if err := s.recoverHarnessHeld(base, id); err != nil {
			return nil, fmt.Errorf("%w; restore source: %v", cause, err)
		}
		if _, err := s.relaunchHeld(base, id, "", s.nativeLog(id) != "", lock); err != nil {
			return nil, fmt.Errorf("%w; restarting source: %v", cause, err)
		}
		return nil, cause
	}
	if err := s.tmux.KillSession(base, sessionName(id)); err != nil {
		return rollback(err)
	}
	if undo.NativeBackup != "" {
		if err := os.Rename(conversationPath(s.Root, id), undo.NativeBackup); err != nil && !os.IsNotExist(err) {
			return rollback(err)
		}
	} else if in.Agent == AgentCodex {
		// Previous Codex segments remain in the journal. A new native
		// translator must not append to an older segment's translation.
		if err := os.Remove(conversationPath(s.Root, id)); err != nil && !os.IsNotExist(err) {
			return rollback(err)
		}
	}
	next := f
	next.Agent, next.Model, next.Gateway, next.Effort = in.Agent, in.Model.Model, in.Model.Gateway, in.Model.Effort
	next.Auth, next.Handoff = in.Auth.Kind, handoff
	if in.Mode != "" {
		next.Plan = in.Mode == ModePlan
	}
	if next.Auth == AuthNone {
		next.Auth = ""
	}
	next.ClaudeSessionID = newSessionID()
	next.CodexSessionID, next.CodexRollout, next.CodexHome, next.CodexLaunchedAt, next.CodexPromptedAt = "", "", "", "", ""
	state := &HarnessState{ID: in.ID, Agent: in.Agent, From: in.ExpectedAgent, Selection: in.Selection, Prompt: in.Prompt}
	state.Mode = ModeBuild
	if next.Plan {
		state.Mode = ModePlan
	}
	next.Harness = state
	auth := ""
	if in.Auth.Kind != AuthNone {
		auth = authEnvFile(in.Auth.Kind, in.Auth.Token)
	}
	if err := s.authFiles().put(id, auth); err != nil {
		return rollback(err)
	}
	env := ""
	if in.Model.Gateway != claude.NoGateway {
		if in.Agent == AgentCodex {
			env = codexGatewayEnvFile(in.Model.Token)
		} else {
			env = gatewayEnvFile(in.Model.Gateway, in.Model.Token, in.Model.Model)
		}
	}
	if err := s.gatewayFiles().put(id, env); err != nil {
		return rollback(err)
	}
	// Never reuse a home logged into the previous account/provider.
	for _, name := range []string{"auth.json", "config.toml"} {
		_ = os.Remove(filepath.Join(s.codexHome(id), name))
	}
	if err := s.persistFacts(id, next); err != nil {
		return rollback(err)
	}
	s.refreshLiveSecrets()
	if _, err := s.relaunchHeld(base, id, "", false, lock); err != nil {
		return rollback(err)
	}
	// Commit only after target readiness. A partial boundary is ignored on
	// recovery; a whole boundary makes retries reuse this exact native session.
	s.journalMu.Lock()
	err = s.writeHarnessState(id, state, true)
	s.journalMu.Unlock()
	if err != nil {
		return rollback(err)
	}
	if err := os.Remove(s.harnessUndoPath(id)); err != nil {
		return nil, err
	}
	return s.finishHarnessHeld(base, id, lock)
}

func codexGateway(g claude.Gateway) bool { return g == claude.OpenRouter }

func (s *Service) finishHarnessHeld(ctx context.Context, id string, lock *sendState) (*HarnessState, error) {
	f, _ := s.getFacts(id)
	state := *f.Harness
	state.Mode = ModeBuild
	if f.Plan {
		state.Mode = ModePlan
	}
	if state.Delivered {
		return &state, nil
	}
	// The target may have exited between retries. Relaunch on its own history.
	if !s.tmux.HasSession(ctx, sessionName(id)) {
		if _, err := s.relaunchHeld(ctx, id, "", s.nativeLog(id) != "", lock); err != nil {
			return nil, err
		}
	}
	if !s.harnessRequestRecorded(id, state.ID) {
		if err := s.deliverHeld(id, s.promptText(id, state.Prompt), lock); err != nil {
			return nil, err
		}
	}
	state.Delivered = true
	s.handedOff(id)
	s.journalMu.Lock()
	err := s.syncHarnessLog(id)
	if err == nil {
		err = s.writeHarnessState(id, &state, false)
	}
	s.journalMu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := s.persistHarnessState(id, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (s *Service) persistHarnessState(id string, state *HarnessState) error {
	s.factsWriteMu.Lock()
	defer s.factsWriteMu.Unlock()
	f, ok := s.getFacts(id)
	if !ok {
		return ErrUnknownWorkspace
	}
	f.Harness = state
	return s.persistFacts(id, f)
}

func (s *Service) updateHarnessModel(id string, selection json.RawMessage) error {
	f, _ := s.getFacts(id)
	if f.Harness == nil || len(selection) == 0 {
		return nil
	}
	state := *f.Harness
	state.Selection = selection
	s.journalMu.Lock()
	err := s.writeHarnessState(id, &state, false)
	s.journalMu.Unlock()
	if err != nil {
		return err
	}
	return s.persistHarnessState(id, &state)
}

func (s *Service) harnessRequestRecorded(id, operation string) bool {
	found := false
	_ = conversation.Walk(s.nativeLog(id), 0, func(ev conversation.Event) bool {
		if ev.Message == nil || ev.Message.Role != "user" {
			return true
		}
		for _, block := range ev.Message.Content {
			if block.Type == "text" && strings.Contains(block.Text, "Continuation operation: "+operation) {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

// A resume is permitted only for a failed/interrupted turn. Assistant progress
// text before a tool call is not a completion; a successful final reply is.
func (s *Service) resumeRequest(id string) (string, error) {
	path := s.SessionLog(id)
	if path == "" {
		return "", errors.New("this chat has no unfinished request; send a new message with the harness change")
	}
	lastPrompt := ""
	unfinished := false
	err := conversation.Walk(path, 0, func(ev conversation.Event) bool {
		m := ev.Message
		if m == nil || m.Meta || m.Compact != nil || m.Harness != nil {
			return true
		}
		if conversation.IsInterruption(m) {
			unfinished = true
			return true
		}
		if m.Role == "user" {
			if t, ok := turnOf(m); ok && strings.TrimSpace(t.text) != "" {
				lastPrompt = t.text
				unfinished = true
			}
			return true
		}
		if m.Role == "assistant" && len(m.Content) > 0 {
			last := m.Content[len(m.Content)-1]
			if m.Model == "<synthetic>" && strings.TrimSpace(last.Text) != "No response requested." {
				unfinished = true
			} else if last.Type == "text" && m.StopReason != "tool_use" {
				unfinished = false
			} else {
				unfinished = true
			}
		}
		return true
	})
	if err != nil {
		return "", err
	}
	if lastPrompt == "" || !unfinished {
		return "", errors.New("this chat has no unfinished request; send a new message with the harness change")
	}
	return "Continue the unfinished request below from the current files and conversation. Inspect existing results before repeating any action.\n\n" + lastPrompt, nil
}

package workspace

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/codex"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/transcript"
)

// A Codex session's conversation is its rollout, which Codex writes in its
// home's sessions folder from the session's first prompt. It is found once
// (codexRollout) and remembered in the session's facts, with the Codex
// session id it is resumed by; a tail per running session (codexTail)
// translates it into $ROOT/conversations/<id>.jsonl, the Claude-shaped log
// SessionLog gives the conversation stream, the Summary and Archive.

// conversationPath is where a workspace's conversation log lives when Runtime
// writes it (a Codex translation, the jcode engine's): outside any worktree,
// keyed by workspace id.
func conversationPath(root, workspaceID string) string {
	return filepath.Join(root, "conversations", workspaceID+".jsonl")
}

// codexTailInterval is how often a running session's rollout is read. Records
// held for their usage wait at most two of these.
const codexTailInterval = 250 * time.Millisecond

// codexStopSettle bounds how long a stop's record waits for Codex to finish
// writing the turn it stopped (codexTail.settle).
const codexStopSettle = time.Second

// rolloutFindSlack allows for a rollout's time and the launch time being read
// off clocks of different precision.
const rolloutFindSlack = 2 * time.Second

// codexHomeFor is the Codex home a session runs in: the one its Codex last
// launched in, which a credential given since doesn't change until the next
// launch; before any, the one it would launch in (launchCodexHome).
func (s *Service) codexHomeFor(workspaceID string) string {
	if f, _ := s.getFacts(workspaceID); f.CodexHome != "" {
		return f.CodexHome
	}
	return s.launchCodexHome(workspaceID)
}

// launchCodexHome is the Codex home a session's next launch runs in: its own,
// with an OpenAI key or on a gateway (codex_auth.go), else the user's:
// CODEX_HOME, or ~/.codex.
func (s *Service) launchCodexHome(workspaceID string) string {
	if s.ownCodexHome(workspaceID) {
		return s.codexHome(workspaceID)
	}
	for _, entry := range s.env {
		if home, ok := strings.CutPrefix(entry, "CODEX_HOME="); ok && home != "" {
			return home
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// codexRollout is the session's rollout, or "" before Codex has written one.
// Once found its session ID is remembered and any resumed copy is followed;
// until then it is looked for:
//   - in a Codex home of the session's own, every rollout is the session's,
//     so it is the newest;
//   - in the user's home, it is a rollout begun since the session launched,
//     filed under today or yesterday (a session launched before midnight),
//     whose working directory is the session's, and that no other session
//     has claimed. The working directories are compared resolved: Codex
//     records the real one (/private/tmp for /tmp).
func (s *Service) codexRollout(workspaceID string) string {
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return ""
	}
	if f.CodexRollout != "" {
		return s.resumedCodexRollout(workspaceID, f)
	}
	// Finding and claiming are one step for every session on this computer:
	// two sessions started together in one folder must not both take the
	// earliest rollout as theirs.
	s.rolloutClaimMu.Lock()
	defer s.rolloutClaimMu.Unlock()
	if f, _ = s.getFacts(workspaceID); f.CodexRollout != "" {
		return s.resumedCodexRollout(workspaceID, f) // claimed while this one waited
	}
	sessions := filepath.Join(s.codexHomeFor(workspaceID), "sessions")
	var found string
	var meta transcript.RolloutMeta
	if s.codexHomeFor(workspaceID) == s.codexHome(workspaceID) && f.Harness == nil {
		found = transcript.NewestRollout(sessions)
		meta, _ = transcript.ReadRolloutMeta(found)
	} else {
		found, meta = s.findRollout(workspaceID, f, sessions)
	}
	if found == "" || meta.ID == "" {
		return ""
	}
	s.updateFacts(workspaceID, func(f *workspaceFacts) {
		f.CodexRollout, f.CodexSessionID, f.CodexLaunchedAt = found, meta.ID, ""
	})
	return found
}

// resumedCodexRollout follows the file Codex writes after resuming a session.
// A restored copy can be the newest when the agent discovers the rollout,
// while Codex resumes appending to the original path for the same session ID.
// Keeping the copy forever then freezes both the stream and send confirmations.
func (s *Service) resumedCodexRollout(workspaceID string, f workspaceFacts) string {
	if f.CodexSessionID == "" {
		return f.CodexRollout
	}
	latest := f.CodexRollout
	var modified time.Time
	var size int64 = -1
	if info, err := os.Stat(latest); err == nil {
		modified = info.ModTime()
		size = info.Size()
	}
	// Resumed files retain the session ID in their name, but their timestamp
	// and date directory can differ. Don't rediscover an unrelated session
	// just because it is newer or has the same working directory.
	paths, _ := filepath.Glob(filepath.Join(s.codexHomeFor(workspaceID), "sessions", "*", "*", "*", "rollout-*-"+f.CodexSessionID+".jsonl"))
	for _, path := range paths {
		if path == f.CodexRollout {
			continue
		}
		info, err := os.Stat(path)
		// Touching/restoring an older snapshot must not take the stream back
		// to a shorter history. Codex appends when it resumes this session ID.
		if err != nil || !info.ModTime().After(modified) || info.Size() <= size {
			continue
		}
		meta, err := transcript.ReadRolloutMeta(path)
		if err != nil || meta.ID != f.CodexSessionID {
			continue
		}
		latest, modified, size = path, info.ModTime(), info.Size()
	}
	if latest == f.CodexRollout {
		return latest
	}
	s.updateFacts(workspaceID, func(current *workspaceFacts) {
		// A concurrent rewind or relaunch may have replaced this conversation
		// while its files were being inspected.
		if current.CodexSessionID == f.CodexSessionID && current.CodexRollout == f.CodexRollout {
			current.CodexRollout = latest
		}
	})
	current, _ := s.getFacts(workspaceID)
	return current.CodexRollout
}

// findRollout looks for a session's rollout in the user's Codex home.
func (s *Service) findRollout(workspaceID string, f workspaceFacts, sessions string) (string, transcript.RolloutMeta) {
	since, err := time.Parse(time.RFC3339Nano, f.CodexLaunchedAt)
	if err != nil {
		// Launched by an agent that has since restarted: the session is no
		// older than its facts.
		if since, err = time.Parse(time.RFC3339, f.CreatedAt); err != nil {
			return "", transcript.RolloutMeta{}
		}
	}
	if s.sharesWorktree(workspaceID) {
		// Another chat's Codex may have begun a rollout here since this one
		// launched: this one's begins no sooner than its own first prompt.
		prompted, err := time.Parse(time.RFC3339Nano, f.CodexPromptedAt)
		// Terminal-typed prompts bypass codexPrompted. Retain the launch bound
		// then; claimedRollouts still excludes other sessions.
		if err == nil && prompted.After(since) {
			since = prompted
		}
	}
	since = since.Add(-rolloutFindSlack)
	worktree := realPath(s.worktreePath(workspaceID))
	claimed := s.claimedRollouts(workspaceID)
	type candidate struct {
		file    string
		meta    transcript.RolloutMeta
		started time.Time
	}
	var candidates []candidate
	now := time.Now()
	seen := map[string]bool{}
	for _, day := range []time.Time{now, now.UTC(), now.AddDate(0, 0, -1), now.UTC().AddDate(0, 0, -1)} {
		dir := filepath.Join(sessions, day.Format("2006"), day.Format("01"), day.Format("02"))
		if seen[dir] {
			continue
		}
		seen[dir] = true
		files, _ := filepath.Glob(filepath.Join(dir, "rollout-*.jsonl"))
		for _, file := range files {
			if claimed[file] {
				continue
			}
			meta, err := transcript.ReadRolloutMeta(file)
			if err != nil || meta.ID == "" || realPath(meta.Cwd) != worktree {
				continue
			}
			// When its conversation began, not when its file last changed: a
			// Codex the user already had running in this folder writes to its
			// older rollout too.
			started, ok := meta.Started()
			if !ok {
				continue
			}
			if !started.Before(since) {
				candidates = append(candidates, candidate{file, meta, started})
			}
		}
	}
	if len(candidates) == 0 {
		return "", transcript.RolloutMeta{}
	}
	// The earliest begun since the launch is the likeliest the session's,
	// should the user have started Codex in the same folder since.
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].started.Before(candidates[j].started) })
	return candidates[0].file, candidates[0].meta
}

// sharesWorktree reports whether other chats work in a key's worktree: it is
// a chat, or a session with chats.
func (s *Service) sharesWorktree(workspaceID string) bool {
	return s.isChat(workspaceID) || len(s.chatKeys(workspaceID)) > 0
}

// codexPrompted records a Codex session's first prompt since its launch,
// before it is sent, while its rollout isn't found (findRollout).
func (s *Service) codexPrompted(workspaceID string) {
	f, _ := s.getFacts(workspaceID)
	if f.Agent != AgentCodex || f.CodexRollout != "" || f.CodexPromptedAt != "" {
		return
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	s.updateFacts(workspaceID, func(f *workspaceFacts) { f.CodexPromptedAt = at })
}

// claimedRollouts are the rollouts other sessions have found as theirs.
func (s *Service) claimedRollouts(workspaceID string) map[string]bool {
	claimed := map[string]bool{}
	entries, _ := os.ReadDir(filepath.Join(s.Root, "facts"))
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || id == workspaceID {
			continue
		}
		if f, ok := s.getFacts(id); ok && f.CodexRollout != "" {
			claimed[f.CodexRollout] = true
		}
	}
	return claimed
}

// realPath resolves symlinks, keeping the path as given when it can't be.
func realPath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

// countUserMessages counts the prompts a rollout recorded (0 before there is
// one): Codex writes a user_message as it takes each.
func countUserMessages(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range bytes.Split(data, []byte("\n")) {
		if !bytes.Contains(line, []byte(`"user_message"`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Type string `json:"type"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &rec) == nil && rec.Type == "event_msg" && rec.Payload.Type == "user_message" {
			count++
		}
	}
	return count
}

// prepareRollout keeps the session's recorded rollout resumable before a
// launch: one deleted since is forgotten (the session starts a new Codex
// conversation, its translated history kept), and one in another Codex home
// than the session now runs in (its credential changed) is copied into this
// one, where `codex resume` looks. With none recorded, the launch time is, to
// find the rollout this launch begins. Either way the home this launch runs
// in is recorded: the running Codex writes there until its next launch.
func (s *Service) prepareRollout(workspaceID string) error {
	// From this launch on, Codex writes in this home.
	home := s.launchCodexHome(workspaceID)
	s.updateFacts(workspaceID, func(f *workspaceFacts) { f.CodexHome = home })
	f, _ := s.getFacts(workspaceID)
	if f.CodexRollout == "" {
		at := time.Now().UTC().Format(time.RFC3339Nano)
		s.updateFacts(workspaceID, func(f *workspaceFacts) { f.CodexLaunchedAt, f.CodexPromptedAt = at, "" })
		return nil
	}
	if _, err := os.Stat(f.CodexRollout); err != nil {
		s.updateFacts(workspaceID, func(f *workspaceFacts) {
			f.CodexRollout, f.CodexSessionID = "", ""
			f.CodexLaunchedAt = time.Now().UTC().Format(time.RFC3339Nano)
		})
		return nil
	}
	sessions := filepath.Join(s.launchCodexHome(workspaceID), "sessions")
	if strings.HasPrefix(f.CodexRollout, sessions+string(filepath.Separator)) {
		return nil
	}
	placed, err := placeRollout(f.CodexRollout, sessions)
	if err != nil {
		return err
	}
	s.updateFacts(workspaceID, func(f *workspaceFacts) { f.CodexRollout = placed })
	return nil
}

// placeRollout copies a rollout into a Codex home's sessions folder, at the
// date folders it was filed under (or today's, for one that wasn't), owner-
// only and atomically, and returns where it put it.
func placeRollout(src, sessions string) (string, error) {
	rel := filepath.Base(src)
	if _, after, ok := strings.Cut(filepath.ToSlash(src), "/sessions/"); ok {
		rel = filepath.FromSlash(after)
	} else {
		rel = filepath.Join(time.Now().Format("2006/01/02"), rel)
	}
	dst := filepath.Join(sessions, rel)
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, dst)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

// codexTail translates one running session's rollout into its conversation
// log as Codex writes it, by byte offset, a partial last line kept for the
// next read.
//
// What it wrote survives it: started again (after a restart of the agent, or
// a crash mid-write), it reads the rollout from the start but writes only
// records past the last one the log holds, which it knows by its uuid
// (codex.RecordOffset). No offset kept elsewhere can disagree with the log.
type codexTail struct {
	s           *Service
	workspaceID string

	// mu serializes reads and writes: the tail's own, and a stop's record
	// (interrupted), which must land after what Codex wrote before it.
	mu sync.Mutex

	rollout string // the rollout read, "" before one is found
	offset  int64
	partial []byte
	tr      *codex.Translator
	// written is the last record the log holds: its rollout session and line.
	writtenSession string
	writtenOffset  int64
	// heldBefore: the translator was holding records at the end of the last
	// read too, so they have waited long enough for their usage.
	heldBefore bool
	// pending is what a write couldn't append (a full disk, say), in order:
	// tried again before anything after it, so the log never skips a record
	// that a restart would then take for written.
	pending []byte
	// failing: the last write failed and was logged, so the next failures
	// aren't, until one succeeds.
	failing bool

	stop context.CancelFunc
	done chan struct{}
}

// startCodexTail starts translating a session's rollout, unless it already is.
func (s *Service) startCodexTail(workspaceID string) {
	s.codexTailsMu.Lock()
	defer s.codexTailsMu.Unlock()
	if s.codexTails[workspaceID] != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	tail := &codexTail{s: s, workspaceID: workspaceID, stop: cancel, done: make(chan struct{})}
	s.codexTails[workspaceID] = tail
	go tail.run(ctx)
}

// stopCodexTail stops a session's tail once it has written what it read.
func (s *Service) stopCodexTail(workspaceID string) {
	s.codexTailsMu.Lock()
	tail := s.codexTails[workspaceID]
	delete(s.codexTails, workspaceID)
	s.codexTailsMu.Unlock()
	if tail != nil {
		tail.stop()
		<-tail.done
	}
}

func (t *codexTail) run(ctx context.Context) {
	defer close(t.done)
	ticker := time.NewTicker(codexTailInterval)
	defer ticker.Stop()
	for {
		t.read()
		select {
		case <-ctx.Done():
			t.mu.Lock()
			t.readLocked()
			if t.tr != nil {
				t.write(t.tr.Flush()) // nothing more is waited for
			}
			t.mu.Unlock()
			return
		case <-ticker.C:
		}
	}
}

// read translates what the rollout gained since the last read.
func (t *codexTail) read() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.readLocked()
}

func (t *codexTail) readLocked() {
	rollout := t.s.codexRollout(t.workspaceID)
	if rollout == "" {
		return
	}
	info, err := os.Stat(rollout)
	if err != nil {
		return
	}
	if rollout != t.rollout || info.Size() < t.offset {
		// A new rollout (a new Codex conversation), or this one cut short
		// (replaced, say, by a restored copy): read it from the start. What
		// the log holds already is not written again.
		t.rollout, t.offset, t.partial, t.heldBefore = rollout, 0, nil, false
		t.tr = codex.NewTranslator()
		t.writtenSession, t.writtenOffset = lastWrittenRecord(conversationPath(t.s.Root, t.workspaceID))
	}
	if info.Size() > t.offset {
		data, err := readFrom(rollout, t.offset, info.Size())
		if err != nil {
			return
		}
		start := t.offset - int64(len(t.partial))
		t.offset += int64(len(data))
		data = append(t.partial, data...)
		for {
			i := bytes.IndexByte(data, '\n')
			if i < 0 {
				break
			}
			t.write(t.tr.Line(start, data[:i+1]))
			start += int64(i + 1)
			data = data[i+1:]
		}
		t.partial = append([]byte(nil), data...)
	}
	if len(t.pending) > 0 {
		t.write(nil) // what couldn't be written before, before anything new
	}
	if !t.tr.Holding() {
		t.heldBefore = false
	} else if t.heldBefore {
		t.write(t.tr.Flush())
		t.heldBefore = false
	} else {
		t.heldBefore = true
	}
}

// interrupted records a stopped turn in the log, after what Codex wrote of it.
// Codex writes nothing when a turn is stopped, so its log ended on the turn's
// last thinking or tool call: read as a turn still going, the page showed the
// session working again on a reload, in another tab, or after a stop from
// Slack, and the box counted it mid-turn. The record is Claude's own for a
// stop, which both already read as the end of a turn. Its uuid is no Codex
// record's (codex.RecordOffset), so a restarted tail neither skips to it nor
// writes it again.
func (t *codexTail) interrupted(now time.Time) {
	t.settle()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.readLocked()
	if t.tr == nil {
		return // no rollout yet: no turn to have stopped
	}
	t.write(t.tr.Flush()) // the stopped turn's records, held for usage that won't come
	line, err := json.Marshal(map[string]any{
		"type":       "user",
		"uuid":       fmt.Sprintf("interrupted-%d", now.UnixNano()),
		"parentUuid": nil,
		"timestamp":  now.UTC().Format(time.RFC3339Nano),
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]string{{"type": "text", "text": conversation.Interrupted + "]"}},
		},
	})
	if err != nil {
		return
	}
	t.pending = append(t.pending, append(line, '\n')...)
	t.write(nil)
}

// settle waits, up to codexStopSettle, for the rollout to stop growing for a
// tail interval: Codex may still write some of the stopped turn once its
// screen says it stopped (a stopped tool call's output, say), which, read
// after the stop's record, would leave the log ending on the turn again.
func (t *codexTail) settle() {
	size := func() int64 {
		if info, err := os.Stat(t.s.codexRollout(t.workspaceID)); err == nil {
			return info.Size()
		}
		return -1
	}
	deadline := time.Now().Add(codexStopSettle)
	for last := size(); time.Now().Before(deadline); {
		time.Sleep(codexTailInterval)
		now := size()
		if now == last {
			return
		}
		last = now
	}
}

// codexInterrupted records a stopped turn in a running Codex session's log
// (codexTail.interrupted); a session with no tail running has none to record.
func (s *Service) codexInterrupted(workspaceID string) {
	s.codexTailsMu.Lock()
	tail := s.codexTails[workspaceID]
	s.codexTailsMu.Unlock()
	if tail != nil {
		tail.interrupted(time.Now())
	}
}

// write appends records the log doesn't hold yet, after any an earlier write
// couldn't. A last line a crash cut short is ended first, so the next record
// doesn't run into it. What can't be written now is kept and tried again on
// the next read.
func (t *codexTail) write(recs []codex.Record) {
	session := t.tr.SessionID()
	for _, rec := range recs {
		if session == t.writtenSession && rec.Offset <= t.writtenOffset {
			continue
		}
		t.pending = append(t.pending, rec.Line...)
	}
	if len(t.pending) == 0 {
		return
	}
	if err := t.s.appendCodexRecords(t.workspaceID, t.pending); err != nil {
		if !t.failing {
			log.Printf("workspace %s: couldn't write its Codex conversation (will retry): %v", t.workspaceID, err)
		}
		t.failing = true
		return
	}
	t.pending, t.failing = nil, false
}

// appendCodexRecords also serializes runtime-owned forms with a translator
// stopping or starting, when its tail is temporarily absent from the map.
func (s *Service) appendCodexRecords(workspaceID string, out []byte) error {
	s.codexLogMu.Lock()
	defer s.codexLogMu.Unlock()
	return appendRecords(conversationPath(s.Root, workspaceID), out)
}

// appendRecords appends whole lines to a conversation log, ending a last line
// a crash cut short first. All or nothing: a write cut short (a full disk) is
// undone, so trying the same lines again never repeats the ones that landed.
func appendRecords(path string, out []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	if size > 0 {
		last := make([]byte, 1)
		if _, err := file.ReadAt(last, size-1); err == nil && last[0] != '\n' {
			out = append([]byte("\n"), out...)
		}
	}
	if _, err := file.Write(out); err != nil {
		_ = file.Truncate(size)
		return err
	}
	return nil
}

// lastWrittenRecord is the session and rollout line of the last translated
// record a conversation log holds, offset -1 when it holds none.
func lastWrittenRecord(path string) (string, int64) {
	session, offset := "", int64(-1)
	file, err := os.Open(path)
	if err != nil {
		return session, offset
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		var rec struct {
			UUID string `json:"uuid"`
		}
		if json.Unmarshal(line, &rec) == nil {
			if id, at, ok := codex.RecordOffset(rec.UUID); ok {
				session, offset = id, at
			}
		}
		if err != nil {
			return session, offset
		}
	}
}

// readFrom reads a file's bytes from offset up to end.
func readFrom(path string, offset, end int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data := make([]byte, end-offset)
	n, err := file.ReadAt(data, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	return data[:n], nil
}

package workspace

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"runtime-agent/internal/codex"
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
// with an OpenAI key (codex_auth.go), else the user's: CODEX_HOME, or ~/.codex.
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
// Once found it is remembered; until then it is looked for:
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
		return f.CodexRollout
	}
	// Finding and claiming are one step for every session on this computer:
	// two sessions started together in one folder must not both take the
	// earliest rollout as theirs.
	s.rolloutClaimMu.Lock()
	defer s.rolloutClaimMu.Unlock()
	if f, _ = s.getFacts(workspaceID); f.CodexRollout != "" {
		return f.CodexRollout // claimed while this one waited
	}
	sessions := filepath.Join(s.codexHomeFor(workspaceID), "sessions")
	var found string
	var meta rolloutMeta
	if s.codexHomeFor(workspaceID) == s.codexHome(workspaceID) {
		found = newestRollout(sessions)
		meta, _ = readRolloutMeta(found)
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

// findRollout looks for a session's rollout in the user's Codex home.
func (s *Service) findRollout(workspaceID string, f workspaceFacts, sessions string) (string, rolloutMeta) {
	since, err := time.Parse(time.RFC3339Nano, f.CodexLaunchedAt)
	if err != nil {
		// Launched by an agent that has since restarted: the session is no
		// older than its facts.
		if since, err = time.Parse(time.RFC3339, f.CreatedAt); err != nil {
			return "", rolloutMeta{}
		}
	}
	since = since.Add(-rolloutFindSlack)
	worktree := realPath(s.worktreePath(workspaceID))
	claimed := s.claimedRollouts(workspaceID)
	type candidate struct {
		file    string
		meta    rolloutMeta
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
			meta, err := readRolloutMeta(file)
			if err != nil || meta.ID == "" || realPath(meta.Cwd) != worktree {
				continue
			}
			// When its conversation began, not when its file last changed: a
			// Codex the user already had running in this folder writes to its
			// older rollout too.
			started, ok := meta.started()
			if !ok {
				continue
			}
			if !started.Before(since) {
				candidates = append(candidates, candidate{file, meta, started})
			}
		}
	}
	if len(candidates) == 0 {
		return "", rolloutMeta{}
	}
	// The earliest begun since the launch is the likeliest the session's,
	// should the user have started Codex in the same folder since.
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].started.Before(candidates[j].started) })
	return candidates[0].file, candidates[0].meta
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

// newestRollout is the most recently written rollout under a sessions folder.
func newestRollout(sessions string) string {
	var newest string
	var newestMod time.Time
	_ = filepath.WalkDir(sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasPrefix(d.Name(), "rollout-") || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().After(newestMod) {
			newest, newestMod = path, info.ModTime()
		}
		return nil
	})
	return newest
}

// rolloutMeta is what a rollout's first line, its session_meta, says.
type rolloutMeta struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
	// Timestamp is when the conversation began (RFC 3339).
	Timestamp string `json:"timestamp"`
}

// started is when the rollout's conversation began; false when its
// session_meta doesn't say, which leaves no way to tell it from an older one.
func (m rolloutMeta) started() (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, m.Timestamp)
	return t, err == nil
}

func readRolloutMeta(path string) (rolloutMeta, error) {
	file, err := os.Open(path)
	if err != nil {
		return rolloutMeta{}, err
	}
	defer file.Close()
	line, err := bufio.NewReader(file).ReadBytes('\n')
	if err != nil {
		return rolloutMeta{}, err // not even a whole first line yet
	}
	var first struct {
		Type    string      `json:"type"`
		Payload rolloutMeta `json:"payload"`
	}
	if err := json.Unmarshal(line, &first); err != nil || first.Type != "session_meta" {
		return rolloutMeta{}, err
	}
	return first.Payload, nil
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
		s.updateFacts(workspaceID, func(f *workspaceFacts) { f.CodexLaunchedAt = at })
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
			t.read()
			if t.tr != nil {
				t.write(t.tr.Flush()) // nothing more is waited for
			}
			return
		case <-ticker.C:
		}
	}
}

// read translates what the rollout gained since the last read.
func (t *codexTail) read() {
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
	if err := appendRecords(conversationPath(t.s.Root, t.workspaceID), t.pending); err != nil {
		if !t.failing {
			log.Printf("workspace %s: couldn't write its Codex conversation (will retry): %v", t.workspaceID, err)
		}
		t.failing = true
		return
	}
	t.pending, t.failing = nil, false
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

package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"runtime-agent/internal/codex"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

const fixtureSessionID = "01a1596f-41f4-7f30-88f4-b569d1b5bf76"

// fixtureRollout is the real rollout in internal/codex/testdata, recorded in
// folder instead of the redacted /work/repo.
func fixtureRollout(t *testing.T, folder string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "codex", "testdata", "rollout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	// Begun now: as a session just launched has it.
	return beganAt(bytes.ReplaceAll(data, []byte(`"/work/repo`), []byte(`"`+folder)), time.Now())
}

// translatedUUIDs are the uuids of a rollout translated whole, in order:
// what a tail must have written once it has read all of it.
func translatedUUIDs(t *testing.T, rollout []byte) []string {
	t.Helper()
	tr := codex.NewTranslator()
	var out []byte
	offset := int64(0)
	for _, line := range bytes.SplitAfter(rollout, []byte("\n")) {
		for _, rec := range tr.Line(offset, line) {
			out = append(out, rec.Line...)
		}
		offset += int64(len(line))
	}
	for _, rec := range tr.Flush() {
		out = append(out, rec.Line...)
	}
	return logUUIDs(t, out)
}

func logUUIDs(t *testing.T, data []byte) []string {
	t.Helper()
	var uuids []string
	for _, line := range bytes.Split(data, []byte("\n")) {
		var rec struct {
			UUID string `json:"uuid"`
		}
		if json.Unmarshal(line, &rec) == nil && rec.UUID != "" {
			uuids = append(uuids, rec.UUID)
		}
	}
	return uuids
}

// writeRollout files a rollout under a sessions folder's date folders, last
// written at mod.
func writeRollout(t *testing.T, sessions string, day time.Time, name string, data []byte, mod time.Time) string {
	t.Helper()
	dir := filepath.Join(sessions, day.Format("2006"), day.Format("01"), day.Format("02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
	return path
}

// beganAt sets when a rollout's conversation began, in its session_meta.
func beganAt(data []byte, at time.Time) []byte {
	first, rest, _ := bytes.Cut(data, []byte("\n"))
	var line map[string]any
	if json.Unmarshal(first, &line) != nil || line["type"] != "session_meta" {
		return data
	}
	line["payload"].(map[string]any)["timestamp"] = at.UTC().Format(time.RFC3339Nano)
	first, _ = json.Marshal(line)
	return append(append(first, '\n'), rest...)
}

// localCodexSession is a Codex session on the user's own Codex login, in a
// folder reached through a symlink (as /tmp is /private/tmp on a Mac), with
// the user's Codex home in a temp folder.
func localCodexSession(t *testing.T) (s *Service, id, link, sessions string) {
	t.Helper()
	real := t.TempDir()
	link = filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	s, _, id = codexSession(t, CreateInput{WorkspaceID: "ws-roll", Branch: "b", BaseBranch: "main", RepoPath: link})
	home := t.TempDir()
	s.env = append(s.env, "CODEX_HOME="+home)
	if err := s.prepareRollout(id); err != nil { // as a launch does: the launch time
		t.Fatal(err)
	}
	return s, id, link, filepath.Join(home, "sessions")
}

func TestARolloutIsFoundByItsFolderAndRemembered(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	if got := s.codexRollout(id); got != "" {
		t.Fatalf("a rollout was found before Codex wrote one: %q", got)
	}
	if got := s.userTurns(id); got != 0 {
		t.Fatalf("userTurns with no rollout = %d", got)
	}
	resolved, _ := filepath.EvalSymlinks(link)
	now := time.Now()
	// Begun before this session launched, in the same folder: not its.
	writeRollout(t, sessions, now, "rollout-2026-10-20T08-00-00-old.jsonl", beganAt(fixtureRollout(t, resolved), now.Add(-time.Hour)), now.Add(-time.Hour))
	// Another folder's.
	writeRollout(t, sessions, now, "rollout-2026-10-20T09-00-00-elsewhere.jsonl", fixtureRollout(t, "/somewhere/else"), now)
	// Claimed by another session (in the same folder).
	claimed := writeRollout(t, sessions, now, "rollout-2026-10-20T09-30-00-claimed.jsonl", fixtureRollout(t, resolved), now)
	s.setFacts("ws-other", workspaceFacts{Agent: AgentCodex, CodexRollout: claimed})
	if got := s.codexRollout(id); got != "" {
		t.Fatalf("found %q, none of which is the session's", got)
	}
	// Its own, under yesterday's folder (launched before midnight), its
	// working directory recorded resolved.
	own := writeRollout(t, sessions, now.AddDate(0, 0, -1), "rollout-2026-10-20T10-00-00-own.jsonl", fixtureRollout(t, resolved), now)
	if got := s.codexRollout(id); got != own {
		t.Fatalf("codexRollout = %q, want %q", got, own)
	}
	f, _ := NewService(s.Root).getFacts(id)
	if f.CodexRollout != own || f.CodexSessionID != fixtureSessionID || f.CodexLaunchedAt != "" {
		t.Errorf("facts = %+v, want the rollout and its session remembered", f)
	}
	if got := s.userTurns(id); got != 4 {
		t.Errorf("userTurns = %d, want the rollout's 4 prompts", got)
	}
	// A newer, different conversation cannot replace the session resumed by id.
	other := bytes.ReplaceAll(fixtureRollout(t, resolved), []byte(fixtureSessionID), []byte("01a1596f-41f4-7f30-88f4-b569d1b5bf77"))
	writeRollout(t, sessions, now, "rollout-2026-10-20T11-00-00-newer.jsonl", other, now.Add(time.Minute))
	if got := s.codexRollout(id); got != own {
		t.Errorf("codexRollout moved to %q", got)
	}
	if argv := s.launchCommand(id, link, true); !slices.Contains(argv, fixtureSessionID) {
		t.Errorf("launch = %q, want it resumed by its session id", argv)
	}
}

func TestARolloutInASessionsOwnHomeIsItsNewest(t *testing.T) {
	s, _, id := codexSession(t, CreateInput{WorkspaceID: "ws-own", Branch: "b", BaseBranch: "main"})
	s.runCommand = (&loginRecorder{}).run
	if err := s.SetAuth(context.Background(), id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	sessions := filepath.Join(s.codexHome(id), "sessions")
	now := time.Now()
	writeRollout(t, sessions, now.AddDate(0, 0, -3), "rollout-a.jsonl", fixtureRollout(t, "/x"), now.Add(-time.Hour))
	newest := writeRollout(t, sessions, now.AddDate(0, 0, -3), "rollout-b.jsonl", fixtureRollout(t, "/y"), now)
	if got := s.codexRollout(id); got != newest {
		t.Errorf("codexRollout = %q, want the newest in its own home %q", got, newest)
	}
}

func TestCodexFollowsTheResumedRolloutInsteadOfAStaleCopy(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	now := time.Now()
	// A restored copy can be newer when the agent first discovers the log,
	// while Codex resumes writing the original path for the same session ID.
	live := writeRollout(t, sessions, now.AddDate(0, 0, -1), "rollout-original-"+fixtureSessionID+".jsonl", data, now.Add(-time.Minute))
	copy := writeRollout(t, sessions, now, "rollout-restored-"+fixtureSessionID+".jsonl", data, now)
	s.updateFacts(id, func(f *workspaceFacts) {
		f.CodexSessionID, f.CodexRollout = fixtureSessionID, copy
	})
	tail := &codexTail{s: s, workspaceID: id}
	drain(tail)
	if got := s.userTurns(id); got != 4 {
		t.Fatalf("initial prompt count = %d, want 4", got)
	}

	more := append(bytes.Clone(data), []byte(`{"timestamp":"2026-10-30T08:21:00Z","type":"event_msg","payload":{"type":"user_message","message":"what is happening?"}}`+"\n")...)
	if err := os.WriteFile(live, more, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(live, now.Add(time.Second), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// A newer conversation in the same home must never take this one over.
	otherID := "01a1596f-41f4-7f30-88f4-b569d1b5bf77"
	other := bytes.ReplaceAll(data, []byte(fixtureSessionID), []byte(otherID))
	writeRollout(t, sessions, now, "rollout-other-"+otherID+".jsonl", other, now.Add(time.Minute))
	// The filename alone is not sufficient to establish the session ID.
	writeRollout(t, sessions, now, "rollout-misnamed-"+fixtureSessionID+".jsonl", other, now.Add(time.Minute))

	if got := s.userTurns(id); got != 5 {
		t.Errorf("prompt count after Codex resumed = %d, want 5", got)
	}
	drain(tail)
	if got := logUUIDs(t, []byte(readFileString(t, conversationPath(s.Root, id)))); !slices.Equal(got, translatedUUIDs(t, more)) {
		t.Errorf("stream after resuming has %d records, want %d without duplicated history", len(got), len(translatedUUIDs(t, more)))
	}
	if f, _ := NewService(s.Root).getFacts(id); f.CodexRollout != live || f.CodexSessionID != fixtureSessionID {
		t.Errorf("persisted facts point to %q, want the live rollout %q", f.CodexRollout, live)
	}
	// A later restore/touch of the shorter copy must not roll the stream or
	// its prompt count back to the older snapshot.
	writeRollout(t, sessions, now, "rollout-another-copy-"+fixtureSessionID+".jsonl", data, now.Add(2*time.Minute))
	if got := s.userTurns(id); got != 5 {
		t.Errorf("a newer stale copy changed the prompt count to %d, want 5", got)
	}
	// A retry of the message already recorded must not paste or submit it again.
	s.sendLock(id).staged = &stagedPrompt{content: "what is happening?", baseline: 4, at: time.Now()}
	if err := s.SendMessage(id, "what is happening?"); err != nil {
		t.Errorf("retry of a delivered Codex prompt = %v, want success", err)
	}
}

// readAll runs a tail's reads until it has translated everything, as its
// goroutine would, then stops it.
func drain(tail *codexTail) {
	for i := 0; i < 3; i++ {
		tail.read()
	}
	tail.write(tail.tr.Flush())
}

func TestATailTranslatesARolloutAsItIsWritten(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	path := writeRollout(t, sessions, time.Now(), "rollout-live.jsonl", nil, time.Now())
	tail := &codexTail{s: s, workspaceID: id}
	if s.SessionLog(id) != "" {
		t.Fatal("a log before any record")
	}
	// Written a few hundred bytes at a time, lines cut anywhere.
	for start := 0; start < len(data); start += 777 {
		end := min(start+777, len(data))
		file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		_, _ = file.Write(data[start:end])
		file.Close()
		tail.read()
	}
	drain(tail)
	log := s.SessionLog(id)
	if log != conversationPath(s.Root, id) {
		t.Fatalf("SessionLog = %q", log)
	}
	got, _ := os.ReadFile(log)
	if uuids := logUUIDs(t, got); !slices.Equal(uuids, translatedUUIDs(t, data)) {
		t.Errorf("translated uuids = %q\nwant %q", uuids, translatedUUIDs(t, data))
	}
}

func TestATailStartedAgainWritesNothingTwice(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	half := bytes.LastIndexByte(data[:len(data)/2], '\n') + 1
	path := writeRollout(t, sessions, time.Now(), "rollout-crash.jsonl", data[:half], time.Now())

	first := &codexTail{s: s, workspaceID: id}
	drain(first)
	// The agent dies mid-write: the log's last line is cut short.
	log := conversationPath(s.Root, id)
	file, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = file.WriteString(`{"type":"assistant","uuid":"codex-` + fixtureSessionID + `-99`)
	file.Close()

	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	second := &codexTail{s: s, workspaceID: id}
	drain(second)
	got, _ := os.ReadFile(log)
	if uuids := logUUIDs(t, got); !slices.Equal(uuids, translatedUUIDs(t, data)) {
		t.Errorf("after a restart, uuids = %q\nwant %q", uuids, translatedUUIDs(t, data))
	}
	// The cut line is left as it was, and the next record on a line of its own.
	if !bytes.Contains(got, []byte(`-99`+"\n"+`{"type"`)) {
		t.Errorf("the record after a cut line ran into it:\n%s", got)
	}

	// The rollout cut short (replaced by a copy of what it held) and grown
	// again: still nothing twice.
	if err := os.WriteFile(path, data[:half], 0o644); err != nil {
		t.Fatal(err)
	}
	second.read()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	drain(second)
	got, _ = os.ReadFile(log)
	if uuids := logUUIDs(t, got); !slices.Equal(uuids, translatedUUIDs(t, data)) {
		t.Errorf("after a truncation, uuids = %q", uuids)
	}
}

func TestANewRolloutIsAppendedAfterTheOld(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	writeRollout(t, sessions, time.Now(), "rollout-1.jsonl", data, time.Now())
	tail := &codexTail{s: s, workspaceID: id}
	drain(tail)

	// The first rollout is deleted; the next launch starts a new conversation.
	f, _ := s.getFacts(id)
	if err := os.Remove(f.CodexRollout); err != nil {
		t.Fatal(err)
	}
	if err := s.prepareRollout(id); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts(id); f.CodexRollout != "" || f.CodexSessionID != "" {
		t.Fatalf("a deleted rollout is still recorded: %+v", f)
	}
	if argv := s.launchCommand(id, link, true); slices.Contains(argv, "resume") {
		t.Errorf("launch = %q, want a fresh conversation, the old one being gone", argv)
	}
	next := bytes.ReplaceAll(data, []byte(fixtureSessionID), []byte("02b2"))
	writeRollout(t, sessions, time.Now(), "rollout-2.jsonl", next, time.Now().Add(time.Second))
	drain(tail)
	got, _ := os.ReadFile(conversationPath(s.Root, id))
	uuids := logUUIDs(t, got)
	if len(uuids) != 2*len(translatedUUIDs(t, data)) || !strings.Contains(uuids[len(uuids)-1], "codex-02b2-") {
		t.Errorf("uuids = %q, want the old conversation then the new", uuids)
	}
}

func TestARolloutFollowsItsSessionIntoAnotherCodexHome(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	day := time.Now()
	old := writeRollout(t, sessions, day, "rollout-moved.jsonl", fixtureRollout(t, resolved), time.Now())
	if s.codexRollout(id) != old {
		t.Fatal("rollout not found")
	}
	// Given an OpenAI key, the session moves to a Codex home of its own.
	s.runCommand = (&loginRecorder{}).run
	if err := s.SetAuth(context.Background(), id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if err := s.agentFor(id).prepare(context.Background(), id); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	f, _ := s.getFacts(id)
	want := filepath.Join(s.codexHome(id), "sessions", day.Format("2006/01/02"), "rollout-moved.jsonl")
	if f.CodexRollout != want || f.CodexSessionID != fixtureSessionID {
		t.Fatalf("facts = %+v, want the rollout copied to %s", f, want)
	}
	if a, b := readFileString(t, old), readFileString(t, want); a != b {
		t.Error("the copy differs")
	}
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestARunningCodexSessionsConversationIsStreamed(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	writeRollout(t, sessions, time.Now(), "rollout-run.jsonl", data, time.Now())
	deadline := time.Now().Add(5 * time.Second)
	for s.SessionLog(id) == "" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if s.SessionLog(id) == "" {
		t.Fatal("the running session's rollout was never translated")
	}
	if err := s.Stop(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(s.SessionLog(id))
	if uuids := logUUIDs(t, got); !slices.Equal(uuids, translatedUUIDs(t, data)) {
		t.Errorf("uuids = %q", uuids)
	}
	if s.codexTails[id] != nil {
		t.Error("the tail outlived Stop")
	}
	if !s.ownsTranscript(func() workspaceFacts { f, _ := s.getFacts(id); return f }()) {
		t.Error("a Codex session's translated log isn't taken as its own")
	}
	s.forgetWorkspace(id)
	if _, err := os.Stat(conversationPath(s.Root, id)); !os.IsNotExist(err) {
		t.Errorf("a forgotten Codex session's translation remains: %v", err)
	}
}

func TestARolloutIsTheOneBegunSinceLaunchNotOneWrittenSince(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	now := time.Now()
	// A Codex the user already had running in this folder: begun an hour ago,
	// written to just now.
	writeRollout(t, sessions, now, "rollout-2026-10-20T08-00-00-users.jsonl", beganAt(fixtureRollout(t, resolved), now.Add(-time.Hour)), now)
	if got := s.codexRollout(id); got != "" {
		t.Fatalf("took %q, a conversation begun before the session launched", got)
	}
	own := writeRollout(t, sessions, now, "rollout-2026-10-20T10-00-00-own.jsonl", fixtureRollout(t, resolved), now)
	if got := s.codexRollout(id); got != own {
		t.Fatalf("codexRollout = %q, want %q", got, own)
	}
}

func TestATailKeepsWhatItCouldNotWriteAndWritesItInOrder(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	half := bytes.LastIndexByte(data[:len(data)/2], '\n') + 1
	path := writeRollout(t, sessions, time.Now(), "rollout-full-disk.jsonl", data[:half], time.Now())
	// The log can't be written: its folder is taken by a file.
	blocked := filepath.Dir(conversationPath(s.Root, id))
	if err := os.WriteFile(blocked, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	tail := &codexTail{s: s, workspaceID: id}
	drain(tail)
	if len(tail.pending) == 0 {
		t.Fatal("nothing kept of what couldn't be written")
	}
	// The rest arrives, and the log can be written again.
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = file.Write(data[half:])
	file.Close()
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	drain(tail)
	got, _ := os.ReadFile(conversationPath(s.Root, id))
	if uuids := logUUIDs(t, got); !slices.Equal(uuids, translatedUUIDs(t, data)) {
		t.Errorf("uuids = %q\nwant every record once, in order: %q", uuids, translatedUUIDs(t, data))
	}
}

func TestARunningCodexIsLookedForInTheHomeItLaunchedIn(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws-home", workspaceFacts{Agent: AgentCodex, Auth: AuthOpenAIAPIKey, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	if err := s.prepareRollout("ws-home"); err != nil { // its launch, in a home of its own
		t.Fatal(err)
	}
	own := s.codexHome("ws-home")
	// Its key is taken away while it runs: that applies at its next launch,
	// and until then its Codex still writes in its own home.
	s.updateFacts("ws-home", func(f *workspaceFacts) { f.Auth = "" })
	if got := s.codexHomeFor("ws-home"); got != own {
		t.Fatalf("codexHomeFor = %q, want the home it launched in, %q", got, own)
	}
	if got := s.launchCodexHome("ws-home"); got == own {
		t.Errorf("the next launch would still use its own home %q", got)
	}
	if err := s.prepareRollout("ws-home"); err != nil { // relaunched
		t.Fatal(err)
	}
	if got := s.codexHomeFor("ws-home"); got == own {
		t.Errorf("codexHomeFor after the relaunch = %q, still its old home", got)
	}
}

func TestTwoSessionsInOneFolderNeverClaimTheSameRollout(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	// A second session in the same folder, launched at the same time.
	f, _ := s.getFacts(id)
	f.CodexRollout, f.CodexSessionID = "", ""
	s.setFacts("ws-twin", f)
	now := time.Now()
	writeRollout(t, sessions, now, "rollout-2026-10-20T10-00-00-a.jsonl", fixtureRollout(t, resolved), now)
	writeRollout(t, sessions, now, "rollout-2026-10-20T10-00-01-b.jsonl", beganAt(fixtureRollout(t, resolved), now.Add(time.Second)), now)
	var wg sync.WaitGroup
	got := make([]string, 2)
	for i, ws := range []string{id, "ws-twin"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i] = s.codexRollout(ws)
		}()
	}
	wg.Wait()
	if got[0] == "" || got[1] == "" || got[0] == got[1] {
		t.Errorf("rollouts = %q, want one each, never the same", got)
	}
}

// lastMessage is the last message a conversation log holds, as the stream
// reads it.
func lastMessage(t *testing.T, log []byte) *protocol.ConversationMessage {
	t.Helper()
	path := filepath.Join(t.TempDir(), "log.jsonl")
	if err := os.WriteFile(path, log, 0o644); err != nil {
		t.Fatal(err)
	}
	events := make(chan conversation.Event, 256)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	go conversation.New(func() string { return path }, 0).Run(ctx, events)
	var last *protocol.ConversationMessage
	for {
		select {
		case ev := <-events:
			if ev.Message != nil {
				last = ev.Message
			}
		case <-ctx.Done():
			return last
		}
	}
}

func TestAStoppedCodexTurnIsRecordedAsStopped(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	resolved, _ := filepath.EvalSymlinks(link)
	data := fixtureRollout(t, resolved)
	// The fixture's third turn was stopped mid-reply: Codex wrote its prompt
	// and reasoning, and nothing more, before the next turn began.
	cut := bytes.Index(data, []byte("Reply with the word resumed."))
	cut = bytes.LastIndex(data[:cut], []byte(`"task_started"`))
	cut = bytes.LastIndexByte(data[:cut], '\n') + 1
	cut = bytes.LastIndex(data[:cut-1], []byte("\n")) + 1 // its thread_settings_applied too
	path := writeRollout(t, sessions, time.Now(), "rollout-stop.jsonl", data[:cut], time.Now())

	tail := &codexTail{s: s, workspaceID: id}
	drain(tail)
	log := conversationPath(s.Root, id)
	got, _ := os.ReadFile(log)
	if conversation.IsInterruption(lastMessage(t, got)) {
		t.Fatal("stopped before the stop")
	}
	// Codex finishes writing the stopped turn just after its screen says it
	// stopped: the stopped call's output lands after the stop is asked for.
	late := `{"timestamp":"2026-10-20T13:11:04.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_late","output":"aborted"}}` + "\n"
	go func() {
		time.Sleep(codexTailInterval / 2)
		file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		_, _ = file.WriteString(late)
		file.Close()
	}()
	tail.interrupted(time.Now())
	got, _ = os.ReadFile(log)
	if !bytes.Contains(got, []byte("call_late")) {
		t.Fatalf("the stopped turn's late output isn't in the log:\n%s", got)
	}
	if last := lastMessage(t, got); !conversation.IsInterruption(last) {
		t.Fatalf("after a stop, the log ends on %+v, not the stop", last)
	}
	data = append(append([]byte(nil), data[:cut]...), append([]byte(late), data[cut:]...)...)

	// The next turn follows the stop, and a tail started again (the agent
	// restarted) writes nothing twice.
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	drain(&codexTail{s: s, workspaceID: id})
	got, _ = os.ReadFile(log)
	codexUUIDs := slices.DeleteFunc(logUUIDs(t, got), func(u string) bool { return strings.HasPrefix(u, "interrupted-") })
	if !slices.Equal(codexUUIDs, translatedUUIDs(t, data)) {
		t.Errorf("uuids after the stop = %q\nwant %q", codexUUIDs, translatedUUIDs(t, data))
	}
	if n := bytes.Count(got, []byte(conversation.Interrupted)); n != 1 {
		t.Errorf("%d stops recorded, want 1", n)
	}
	stop := bytes.Index(got, []byte(conversation.Interrupted))
	if next := bytes.Index(got, []byte("Reply with the word resumed.")); next < stop {
		t.Error("the stop was recorded after the turn that came next")
	}
}

func TestSharedCodexDiscoveryFallsBackToLaunchForTerminalPrompts(t *testing.T) {
	s, id, link, sessions := localCodexSession(t)
	s.setFacts(ChatKey(id, "c1"), workspaceFacts{Parent: id, Agent: AgentClaude})
	resolved, _ := filepath.EvalSymlinks(link)
	now := time.Now()
	claimed := writeRollout(t, sessions, now, "rollout-claimed.jsonl", beganAt(fixtureRollout(t, resolved), now.Add(-19*time.Second)), now)
	s.setFacts("claimed", workspaceFacts{Agent: AgentCodex, CodexRollout: claimed})
	terminal := writeRollout(t, sessions, now, "rollout-terminal.jsonl", beganAt(fixtureRollout(t, resolved), now.Add(-15*time.Second)), now)
	prompted := writeRollout(t, sessions, now, "rollout-prompted.jsonl", beganAt(fixtureRollout(t, resolved), now.Add(-time.Second)), now)
	f, _ := s.getFacts(id)
	f.CodexLaunchedAt = now.Add(-20 * time.Second).UTC().Format(time.RFC3339Nano)
	if got, _ := s.findRollout(id, f, sessions); got != terminal {
		t.Fatalf("terminal-typed rollout = %q, want %q", got, terminal)
	}
	f.CodexPromptedAt = now.Add(-5 * time.Second).UTC().Format(time.RFC3339Nano)
	if got, _ := s.findRollout(id, f, sessions); got != prompted {
		t.Fatalf("API-prompted rollout = %q, want %q", got, prompted)
	}
}

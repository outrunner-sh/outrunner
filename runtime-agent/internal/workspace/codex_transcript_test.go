package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/codex"
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
	// A rollout found is kept, newer ones notwithstanding, and resumed by id.
	writeRollout(t, sessions, now, "rollout-2026-10-20T11-00-00-newer.jsonl", fixtureRollout(t, resolved), now.Add(time.Minute))
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

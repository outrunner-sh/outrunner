package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// A conversation of two turns, the second prompt the one edited.
const twoTurns = `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-10-29T10:00:00Z","message":{"role":"user","content":"Add dark mode"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-10-29T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Added it."}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-10-29T10:01:00Z","message":{"role":"user","content":"Now make it blue"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-10-29T10:01:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Blue it is."}]}}
`

// rewindSession is a running cloud session with twoTurns as its Claude
// conversation.
func rewindSession(t *testing.T) (*Service, *fakeSessions, string, string) {
	t.Helper()
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-edit", Branch: "b", BaseBranch: "main"})
	log := writeTranscript(t, s, "ws-edit", "sess-1.jsonl", twoTurns, time.Minute)
	fake := s.tmux.(*fakeSessions)
	fake.running[sessionName("ws-edit")] = true
	return s, fake, "ws-edit", log
}

func TestAnEditCutsTheConversationBackToJustBeforeItsPrompt(t *testing.T) {
	s, fake, id, log := rewindSession(t)
	cut, err := s.Rewind(context.Background(), id, "u2")
	if err != nil {
		t.Fatalf("Rewind: %v", err)
	}
	data, _ := os.ReadFile(log)
	if want := strings.SplitAfterN(twoTurns, "\n", 3); string(data) != want[0]+want[1] {
		t.Fatalf("log after the edit:\n%s\nwant the first turn alone", data)
	}
	if cut.At != int64(len(data)) || cut.UUID != "u2" || cut.Rewinds != 1 {
		t.Errorf("cut = %+v, want at %d, u2, the first", cut, len(data))
	}
	kept, err := os.ReadFile(log + ".rewound-1")
	if err != nil || !strings.Contains(string(kept), "Now make it blue") {
		t.Errorf("what the edit cut wasn't kept: %v %q", err, kept)
	}
	// Claude was launched again on what is left, by its id.
	if launch := fake.lastLaunch(); !slices.Contains(launch, "--resume") || !slices.Contains(launch, "sess-1") {
		t.Errorf("relaunch = %q, want --resume sess-1", launch)
	}
	if n, at, uuid := s.LogRewind(id); n != 1 || at != cut.At || uuid != "u2" {
		t.Errorf("LogRewind = %d %d %q", n, at, uuid)
	}
}

func TestEditingTheFirstPromptStartsTheConversationAfresh(t *testing.T) {
	s, fake, id, log := rewindSession(t)
	if _, err := s.Rewind(context.Background(), id, "u1"); err != nil {
		t.Fatalf("Rewind: %v", err)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Errorf("an empty log was left to resume: %v", err)
	}
	if launch := fake.lastLaunch(); slices.Contains(launch, "--resume") || !slices.Contains(launch, "--session-id") {
		t.Errorf("relaunch = %q, want a new conversation under its id", launch)
	}
}

func TestAnEditIsRefusedWhileTheAgentWorksOrOfWhatIsntAPrompt(t *testing.T) {
	s, fake, id, log := rewindSession(t)
	fake.pane = "✶ Combobulating…\n  ⏵⏵ accept edits on · esc to interrupt"
	if _, err := s.Rewind(context.Background(), id, "u2"); !errors.Is(err, ErrRewindBusy) {
		t.Errorf("an edit mid-turn = %v, want ErrRewindBusy", err)
	}
	fake.pane = composerPane
	for _, uuid := range []string{"a1", "nope"} {
		if _, err := s.Rewind(context.Background(), id, uuid); !errors.Is(err, ErrNotAPrompt) {
			t.Errorf("an edit of %s = %v, want ErrNotAPrompt", uuid, err)
		}
	}
	if data, _ := os.ReadFile(log); string(data) != twoTurns {
		t.Error("a refused edit changed the log")
	}
}

func TestAStoppedSessionsEditWaitsForItsNextStart(t *testing.T) {
	s, fake, id, _ := rewindSession(t)
	fake.running[sessionName(id)] = false
	launches := len(fake.launches)
	if _, err := s.Rewind(context.Background(), id, "u2"); err != nil {
		t.Fatalf("Rewind: %v", err)
	}
	if len(fake.launches) != launches {
		t.Errorf("a stopped session was launched by an edit: %q", fake.launches[launches:])
	}
}

func TestACodexChatsEditStartsANewConversationWithTheOneBeforeIt(t *testing.T) {
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main", Agent: AgentCodex})
	log := conversationPath(s.Root, "ws-cx")
	if err := os.MkdirAll(filepath.Dir(log), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, []byte(twoTurns), 0o644); err != nil {
		t.Fatal(err)
	}
	rollout := filepath.Join(t.TempDir(), "rollout-2026-10-29T10-00-00-abc.jsonl")
	if err := os.WriteFile(rollout, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.updateFacts("ws-cx", func(f *workspaceFacts) { f.CodexRollout, f.CodexSessionID = rollout, "abc" })
	if _, err := s.Rewind(context.Background(), "ws-cx", "u2"); err != nil {
		t.Fatalf("Rewind: %v", err)
	}
	f, _ := s.getFacts("ws-cx")
	if f.CodexRollout != "" || f.CodexSessionID != "" {
		t.Errorf("the old Codex conversation is still the chat's: %+v", f)
	}
	if _, err := os.Stat(rollout); !os.IsNotExist(err) {
		t.Error("the old rollout is where a new one would be looked for")
	}
	if _, err := os.Stat(rollout + ".rewound-1"); err != nil {
		t.Errorf("the old rollout wasn't kept: %v", err)
	}
	if !strings.HasPrefix(f.Handoff, handoffOpen) || !strings.Contains(f.Handoff, "Added it.") || strings.Contains(f.Handoff, "Blue it is.") {
		t.Errorf("handoff = %q, want the conversation before the edit", f.Handoff)
	}
	if text := s.promptText("ws-cx", "Now make it green"); !strings.HasSuffix(text, "Now make it green") || !strings.HasPrefix(text, handoffOpen) {
		t.Errorf("the edited prompt goes as %q", text)
	}
}

type rewindKillFailure struct{ Sessions }

func (rewindKillFailure) KillSession(context.Context, string) error {
	return errors.New("kill refused")
}

func TestARewindDoesNotCutWhenStoppingTheSessionFails(t *testing.T) {
	s, _, id, log := rewindSession(t)
	s.tmux = rewindKillFailure{s.tmux}
	if _, err := s.Rewind(context.Background(), id, "u2"); !errors.Is(err, ErrSessionUnchecked) {
		t.Fatalf("got %v", err)
	}
	data, _ := os.ReadFile(log)
	if string(data) != twoTurns {
		t.Fatal("log cut while agent could still write")
	}
	if n, _, _ := s.LogRewind(id); n != 0 {
		t.Fatal("failed stop recorded an edit")
	}
}

type settlingRewindSessions struct {
	Sessions
	killed bool
	probes int
	log    string
	t      *testing.T
}

func (s *settlingRewindSessions) KillSession(ctx context.Context, name string) error {
	s.killed = true
	return s.Sessions.KillSession(ctx, name)
}
func (s *settlingRewindSessions) SessionExists(ctx context.Context, name string) (bool, error) {
	if s.killed && s.probes < 2 {
		s.probes++
		data, _ := os.ReadFile(s.log)
		if string(data) != twoTurns {
			s.t.Error("log cut before session exit was observed")
		}
		return true, nil
	}
	return s.Sessions.SessionExists(ctx, name)
}
func TestARewindWaitsForTheStoppedSessionBeforeCutting(t *testing.T) {
	s, _, id, log := rewindSession(t)
	sessions := &settlingRewindSessions{Sessions: s.tmux, log: log, t: t}
	s.tmux = sessions
	if _, err := s.Rewind(context.Background(), id, "u2"); err != nil {
		t.Fatal(err)
	}
	if sessions.probes != 2 {
		t.Fatal("did not wait for exit")
	}
}

func TestACodexRewindLeavesTheLogIntactWhenPreparationFails(t *testing.T) {
	for _, failure := range []string{"handoff", "rollout"} {
		t.Run(failure, func(t *testing.T) {
			s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-cx-fail", Branch: "b", BaseBranch: "main", Agent: AgentCodex})
			id := "ws-cx-fail"
			log := conversationPath(s.Root, id)
			if err := os.MkdirAll(filepath.Dir(log), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(log, []byte(twoTurns), 0o600); err != nil {
				t.Fatal(err)
			}
			if failure == "handoff" {
				path := filepath.Dir(s.handoffPath(id, MainChat+"-before-edit"))
				_ = os.MkdirAll(filepath.Dir(path), 0o755)
				if err := os.WriteFile(path, []byte("not a directory"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				s.updateFacts(id, func(f *workspaceFacts) { f.CodexRollout = filepath.Join(t.TempDir(), "gone.jsonl") })
			}
			if _, err := s.Rewind(context.Background(), id, "u2"); err == nil {
				t.Fatal("expected preparation failure")
			}
			data, _ := os.ReadFile(log)
			if string(data) != twoTurns {
				t.Fatal("preparation failure cut the conversation")
			}
			if n, _, _ := s.LogRewind(id); n != 0 {
				t.Fatal("preparation failure recorded a cut")
			}
		})
	}
}

func TestAFailedEditRelaunchStillRecordsTheCutForStreams(t *testing.T) {
	s, fake, id, log := rewindSession(t)
	fake.newErrs = []error{errors.New("launch failed"), errors.New("launch failed"), errors.New("launch failed")}
	if _, err := s.Rewind(context.Background(), id, "u2"); err == nil {
		t.Fatal("expected relaunch failure")
	}
	if n, _, uuid := s.LogRewind(id); n != 1 || uuid != "u2" {
		t.Fatal("completed cut was not recorded")
	}
	data, _ := os.ReadFile(log)
	if strings.Contains(string(data), "Now make it blue") {
		t.Fatal("log not cut")
	}
}

func TestEditHandoffAlignsALongPrefixAndNamesItsOriginalLog(t *testing.T) {
	s, _, id, log := rewindSession(t)
	data := strings.Repeat(" ", int(handoffReadLimit)+123) + `{"type":"user","message":{"role":"user","content":"partial-record-must-not-leak"}}` + "\n" + twoTurns
	if err := os.WriteFile(log, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.editHandoffBefore(id, log, int64(len(data))); err != nil {
		t.Fatal(err)
	}
	doc, err := os.ReadFile(s.handoffPath(id, MainChat+"-before-edit"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(doc), "partial-record-must-not-leak") {
		t.Fatal("leading partial record entered the handoff")
	}
	if !strings.Contains(string(doc), "Only the most recent part") || !strings.Contains(string(doc), log) {
		t.Fatalf("missing truncation warning and original log: %s", doc)
	}
	if !strings.Contains(string(doc), "Now make it blue") {
		t.Fatal("complete recent record was lost")
	}
}

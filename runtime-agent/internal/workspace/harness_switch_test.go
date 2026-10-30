package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

const exhaustedChat = `{"type":"user","uuid":"request","message":{"role":"user","content":"Finish the settings change; attached file: .context/design.png"}}
{"type":"assistant","uuid":"progress","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"Inspecting the current changes."},{"type":"tool_use","id":"call","name":"Read","input":{}}]}}
{"type":"assistant","uuid":"limit","message":{"role":"assistant","model":"<synthetic>","content":"You've hit your limit; resets tomorrow"}}
`

const claudeLimitMenu = `You've hit your weekly limit · resets Nov 1, 3pm (UTC)
   What do you want to do?
   ❯ 1. Stop and wait for limit to reset
     2. Wait here, then continue automatically at Nov 1, 3pm
   Enter to confirm · Esc to cancel
`

func TestHarnessDismissesOnlyTheClaudeQuotaMenu(t *testing.T) {
	for _, tc := range []struct {
		name, pane string
		quota      bool
	}{
		{"quota", claudeLimitMenu, true},
		{"quoted", claudeLimitMenu + composerPane, false},
		{"approval", realPane(t, "plan-menu"), false},
		{"trust", realPane(t, "trust"), false},
		{"permission", "  ❯ 1. Yes\n    2. No\nEnter to confirm · Esc to cancel", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isClaudeLimitDialog(tc.pane); got != tc.quota {
				t.Fatalf("quota dialog = %t, want %t", got, tc.quota)
			}
		})
	}
	s, fake, id := harnessFixture(t)
	s.updateFacts(id, func(f *workspaceFacts) { f.Agent = AgentClaude })
	writeTranscript(t, s, id, "source.jsonl", exhaustedChat, 0)
	fake.pane = claudeLimitMenu
	fake.onKey = func(key string) string {
		if key == "Escape" {
			return composerPane + "\n› Ask anything\nfixture high · folder"
		}
		return ""
	}
	in := harnessChoice("quota-menu", AgentClaude, AgentCodex)
	if _, err := s.SwitchHarness(context.Background(), id, in); err != nil {
		t.Fatal(err)
	}
}

func harnessFixture(t *testing.T) (*Service, *fakeSessions, string) {
	t.Helper()
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-harness", Branch: "b", BaseBranch: "main", Agent: AgentCodex})
	id := "ws-harness"
	s.lookPath = func(string) (string, error) { return "/fixture/codex", nil }
	fake := s.tmux.(*fakeSessions)
	fake.pane = composerPane + "\n› Ask anything\nfixture high · folder"
	fake.running[sessionName(id)] = true
	if err := writeKeysFile(conversationPath(s.Root, id), exhaustedChat); err != nil {
		t.Fatal(err)
	}
	fake.onEnter = func() string {
		f, _ := s.getFacts(id)
		content := fake.pasted[len(fake.pasted)-1]
		if f.Agent == AgentClaude {
			rec, _ := json.Marshal(map[string]any{"type": "user", "uuid": "native-" + f.Harness.ID, "message": map[string]any{"role": "user", "content": content}})
			path, _ := s.conversationDest(s.worktreePath(id), f.ClaudeSessionID)
			prior, _ := os.ReadFile(path)
			if err := writeKeysFile(path, string(prior)+string(rec)+"\n"); err != nil {
				t.Error(err)
			}
		} else {
			rollout := filepath.Join(s.Root, "fixture-rollouts", f.Harness.ID+".jsonl")
			meta, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]any{"id": f.Harness.ID, "cwd": s.worktreePath(id)}})
			prompt, _ := json.Marshal(map[string]any{"type": "event_msg", "payload": map[string]any{"type": "user_message", "message": content}})
			if err := writeKeysFile(rollout, string(meta)+"\n"+string(prompt)+"\n"); err != nil {
				t.Error(err)
			}
			s.updateFacts(id, func(f *workspaceFacts) { f.CodexRollout = rollout; f.CodexSessionID = f.Harness.ID })
		}
		return ""
	}
	t.Cleanup(func() { s.endSummary(id); s.stopRecorder(context.Background(), id) })
	return s, fake, id
}

func harnessChoice(id, from, to string) HarnessInput {
	return HarnessInput{ID: id, Agent: to, ExpectedAgent: from, Model: ModelChoice{Model: "sonnet"}, Auth: protocol.SetAuthRequest{Kind: AuthNone}, Selection: json.RawMessage(`{"model":{"id":"sonnet","label":"Sonnet","provider":"claude"},"effort":null}`), Resume: true}
}

func TestHarnessSwitchKeepsAddressHistoryAndRequestAcrossRetries(t *testing.T) {
	s, fake, id := harnessFixture(t)
	in := harnessChoice("op-one", AgentCodex, AgentClaude)
	state, err := s.SwitchHarness(context.Background(), id, in)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Delivered || state.Agent != AgentClaude {
		t.Fatalf("state=%+v", state)
	}
	if _, err := s.AcknowledgeHarness(context.Background(), id, in.ID); err != nil {
		t.Fatal(err)
	}
	before := fake.pastes
	if _, err := s.SwitchHarness(context.Background(), id, in); err != nil {
		t.Fatal(err)
	}
	if fake.pastes != before {
		t.Fatal("retry delivered the continuation twice")
	}
	if !strings.Contains(fake.pasted[0], "Finish the settings change") || !strings.Contains(fake.pasted[0], ".context/design.png") {
		t.Fatal("unfinished request or attachment reference lost")
	}
	data, err := os.ReadFile(s.SessionLog(id))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(data), exhaustedChat) {
		t.Fatal("original cursors/history changed")
	}
	events, err := conversation.Read(s.SessionLog(id), int64(len(exhaustedChat)))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Message.Harness == nil || events[1].Message.Role != "user" {
		t.Fatalf("events after source cursor=%+v", events)
	}
	// Restart loses in-memory locks and offsets. Native request identity and
	// the public journal still prevent another delivery/copy.
	s.endSummary(id)
	restarted := NewService(s.Root)
	restarted.tmux = fake
	if _, err := restarted.SwitchHarness(context.Background(), id, in); err != nil {
		t.Fatal(err)
	}
	if fake.pastes != before {
		t.Fatal("restart redelivered the request")
	}
	if got, _ := os.ReadFile(restarted.SessionLog(id)); string(got) != string(data) {
		t.Fatal("restart duplicated journal records")
	}
}

func TestHarnessLaunchFailureRestoresSourceAndCredentials(t *testing.T) {
	s, fake, id := harnessFixture(t)
	source, _ := s.getFacts(id)
	oldAuth := "export OPENAI_API_KEY='fixture-source-key'\n"
	if err := s.authFiles().put(id, oldAuth); err != nil {
		t.Fatal(err)
	}
	fake.newErrs = []error{errors.New("target failed"), nil}
	if _, err := s.SwitchHarness(context.Background(), id, harnessChoice("op-fail", AgentCodex, AgentClaude)); err == nil {
		t.Fatal("expected launch failure")
	}
	f, _ := s.getFacts(id)
	if f.Agent != source.Agent || f.Harness != nil || s.authFiles().read(id) != oldAuth {
		t.Fatal("failed target changed source selection/auth")
	}
	if !fake.running[sessionName(id)] {
		t.Fatal("source not restarted")
	}
	if got, _ := os.ReadFile(s.SessionLog(id)); string(got) != exhaustedChat {
		t.Fatal("source history changed")
	}
}

func TestHarnessJournalSurvivesSwitchBackAndPortableRestore(t *testing.T) {
	s, _, id := harnessFixture(t)
	first := harnessChoice("op-first", AgentCodex, AgentClaude)
	if _, err := s.SwitchHarness(context.Background(), id, first); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcknowledgeHarness(context.Background(), id, first.ID); err != nil {
		t.Fatal(err)
	}
	second := harnessChoice("op-second", AgentClaude, AgentCodex)
	second.Resume = false
	second.Prompt = "Check the implementation and continue"
	if _, err := s.SwitchHarness(context.Background(), id, second); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcknowledgeHarness(context.Background(), id, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SwitchHarness(context.Background(), id, first); !errors.Is(err, ErrHarnessConflict) {
		t.Fatal("a stale operation switched the chat again", err)
	}
	time.Sleep(300 * time.Millisecond)
	s.endSummary(id)
	journal, err := os.ReadFile(s.SessionLog(id))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(journal), "op-first") || !strings.Contains(string(journal), "op-second") {
		t.Fatal("prior segment lost")
	}
	// Restore into a different root. Only the active segment enters the native
	// transcript; all earlier segments remain in the public conversation.
	restored := NewService(t.TempDir())
	restored.tmux = newFakeSessions()
	restored.setFacts(id, workspaceFacts{Agent: AgentCodex})
	dest := conversationPath(restored.Root, id)
	if err := writeKeysFile(dest, string(journal)); err != nil {
		t.Fatal(err)
	}
	if err := restored.restoreHarnessJournal(id, dest); err != nil {
		t.Fatal(err)
	}
	native, _ := os.ReadFile(dest)
	if strings.Contains(string(native), `"uuid":"request"`) {
		t.Fatal("source vendor's records entered the active native log")
	}
	if got, _ := os.ReadFile(restored.SessionLog(id)); !strings.HasPrefix(string(got), string(journal)) {
		t.Fatal("portable history lost")
	}
	// A second restore must retain the same active segment, without replaying
	// its native records into the public journal.
	newJournal, _ := os.ReadFile(restored.SessionLog(id))
	if err := writeKeysFile(dest, string(newJournal)); err != nil {
		t.Fatal(err)
	}
	if err := restored.restoreHarnessJournal(id, dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); string(got) != string(native) {
		t.Fatal("repeated restore changed active native transcript")
	}
}

func TestHarnessResumeDoesNotRepeatCompletedWork(t *testing.T) {
	s, _, id := harnessFixture(t)
	if err := writeKeysFile(conversationPath(s.Root, id), mainTranscript); err != nil {
		t.Fatal(err)
	}
	if _, err := s.resumeRequest(id); err == nil {
		t.Fatal("completed request would be replayed")
	}
	quiet := `{"type":"user","uuid":"quiet","message":{"role":"user","content":"Record this without a reply"}}
{"type":"assistant","uuid":"quiet-response","message":{"role":"assistant","model":"<synthetic>","content":"No response requested."}}
`
	if err := writeKeysFile(conversationPath(s.Root, id), quiet); err != nil {
		t.Fatal(err)
	}
	if _, err := s.resumeRequest(id); err == nil {
		t.Fatal("a completed no-response request would be replayed")
	}
	if err := writeKeysFile(conversationPath(s.Root, id), exhaustedChat); err != nil {
		t.Fatal(err)
	}
	if _, err := s.resumeRequest(id); err != nil {
		t.Fatal(err)
	}
}

func TestHarnessHoldsMissionDeliveriesUntilSelectionIsSaved(t *testing.T) {
	s, fake, id := harnessFixture(t)
	in := harnessChoice("op-mission", AgentCodex, AgentClaude)
	if _, err := s.SwitchHarness(context.Background(), id, in); err != nil {
		t.Fatal(err)
	}
	pastes := fake.pastes
	if err := s.SendMessageOnce(id, "<runner_event>Ship finished</runner_event>", "runner-delivery"); !errors.Is(err, ErrHarnessConflict) {
		t.Fatal("delivery was not held", err)
	}
	if fake.pastes != pastes {
		t.Fatal("held delivery reached the composer")
	}
	if _, err := s.AcknowledgeHarness(context.Background(), id, in.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SendMessageOnce(id, "<runner_event>Ship finished</runner_event>", "runner-delivery"); err != nil {
		t.Fatal(err)
	}
	if err := s.SendMessageOnce(id, "<runner_event>Ship finished</runner_event>", "runner-delivery"); err != nil {
		t.Fatal(err)
	}
	if fake.pastes != pastes+1 {
		t.Fatal("Mission delivery was lost or duplicated")
	}
}

func TestHarnessRecoversAnUncommittedTargetAfterProcessCrash(t *testing.T) {
	s, fake, id := harnessFixture(t)
	f, _ := s.getFacts(id)
	if err := writeKeysFile(s.journalPath(id), exhaustedChat); err != nil {
		t.Fatal(err)
	}
	backup := conversationPath(s.Root, id) + ".before-crash"
	if err := os.Rename(conversationPath(s.Root, id), backup); err != nil {
		t.Fatal(err)
	}
	undo := harnessUndo{Facts: f, Auth: "export OPENAI_API_KEY='source-fixture'\n", JournalSize: int64(len(exhaustedChat)), NativeBackup: backup}
	data, _ := json.Marshal(undo)
	if err := writeKeysFile(s.harnessUndoPath(id), string(data)); err != nil {
		t.Fatal(err)
	}
	next := f
	next.Agent = AgentClaude
	next.Harness = &HarnessState{ID: "uncommitted", Agent: AgentClaude}
	if err := s.persistFacts(id, next); err != nil {
		t.Fatal(err)
	}
	restarted := NewService(s.Root)
	restarted.tmux = fake
	state, err := restarted.HarnessSelection(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	current, _ := restarted.getFacts(id)
	if state != nil || current.Agent != AgentCodex {
		t.Fatal("uncommitted target survived recovery")
	}
	if got, _ := os.ReadFile(restarted.nativeLog(id)); string(got) != exhaustedChat {
		t.Fatal("source log was not restored")
	}
	if restarted.authFiles().read(id) != undo.Auth {
		t.Fatal("source credential was not restored")
	}
}

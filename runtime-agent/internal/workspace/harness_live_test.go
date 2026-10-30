package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

// TestHarnessLiveQuotaHandoff uses real CLIs and provider inference. Opt in
// with OUTRUNNER_LIVE_HANDOFF=1 and a private outrunner-handoff-test-* tmux
// socket. Claude must already be logged in and exhausted; OPENAI_API_KEY is
// the destination credential. No account files or credentials are printed.
func TestHarnessLiveQuotaHandoff(t *testing.T) {
	if os.Getenv("OUTRUNNER_LIVE_HANDOFF") != "1" {
		t.Skip("set OUTRUNNER_LIVE_HANDOFF=1 to spend provider tokens")
	}
	if !strings.HasPrefix(os.Getenv("RUNTIME_TMUX_SOCKET"), "outrunner-handoff-test-") {
		t.Fatal("use a private outrunner-handoff-test-* tmux socket")
	}
	key := os.Getenv("OPENAI_API_KEY")
	if key == "" {
		t.Fatal("the opt-in live handoff requires OPENAI_API_KEY")
	}
	for _, bin := range []string{"tmux", "claude", "codex"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	s := NewService(t.TempDir())
	s.env = withoutEnv(s.env, "CLAUDECODE")
	id := "live-handoff-" + newSessionID()
	// A disposable cloud worktree, separate from both the repository under
	// review and the agent's own live chat. No local desktop selection involved.
	seedRepo := t.TempDir()
	run(t, seedRepo, "init", "-q", "-b", "main")
	run(t, seedRepo, "commit", "--allow-empty", "-q", "-m", "Seed handoff test\n\nCo-Authored-By: immad sahin <84772210+immadsahin@users.noreply.github.com>\nCo-Authored-By: replicas-connector[bot] <replicas-connector[bot]@users.noreply.github.com>")
	run(t, seedRepo, "clone", "-q", "--bare", seedRepo, s.mirrorPath())
	run(t, s.mirrorPath(), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	run(t, s.mirrorPath(), "fetch", "-q", "origin")
	folder := s.worktreePath(id)
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: id, Branch: "handoff-test", BaseBranch: "main", Agent: AgentClaude, Model: "sonnet", PermissionMode: claude.AcceptEdits}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Destroy(context.Background(), id) })
	branch := run(t, folder, "branch", "--show-current")
	head := run(t, folder, "rev-parse", "HEAD")
	seed := "preserved-" + newSessionID() + "\n"
	if err := os.WriteFile(filepath.Join(folder, "seed.txt"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	request := "Read seed.txt and write its exact contents to result.txt. Reply HANDOFF_DONE after checking the file. Do not commit, delegate, contact anyone, or use network tools."
	if err := s.SendMessage(id, request); err != nil {
		t.Fatal(err)
	}
	waitFor := func(label string, ready func() bool) {
		t.Helper()
		deadline := time.Now().Add(90 * time.Second)
		for ctx.Err() == nil && time.Now().Before(deadline) {
			if ready() {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s", label)
	}
	waitFor("real Claude quota error", func() bool {
		data, _ := os.ReadFile(s.SessionLog(id))
		return bytes.Contains(data, []byte("hit your")) && bytes.Contains(data, []byte("limit"))
	})
	if _, err := s.resumeRequest(id); err != nil {
		t.Fatalf("real quota response was not resumable: %v", err)
	}
	source, err := os.ReadFile(s.SessionLog(id))
	if err != nil {
		t.Fatal(err)
	}
	t.Log("Real Claude quota failure recorded; original request is resumable")
	model := os.Getenv("OUTRUNNER_HANDOFF_CODEX_MODEL")
	if model == "" {
		model = "gpt-5.5"
	}
	selection, _ := json.Marshal(map[string]any{"model": map[string]string{"id": model, "label": model, "provider": "codex"}, "effort": nil})
	in := HarnessInput{ID: "live-" + newSessionID(), ExpectedAgent: AgentClaude, Agent: AgentCodex, Resume: true,
		Model: ModelChoice{Model: model}, Selection: selection, Auth: protocol.SetAuthRequest{Kind: AuthOpenAIAPIKey, Token: key}}
	state, err := s.SwitchHarness(ctx, id, in)
	if err != nil {
		pane, _ := s.tmux.CapturePane(ctx, sessionName(id))
		t.Logf("source terminal: %s", s.masker()(pane))
		f, _ := s.getFacts(id)
		t.Logf("Codex session=%q rollout=%q home=%q turns=%d", f.CodexSessionID, f.CodexRollout, f.CodexHome, s.userTurns(id))
		t.Fatalf("switch to real Codex: %v", err)
	}
	if !state.Delivered || state.Agent != AgentCodex || s.Worktree(id) != folder {
		t.Fatal("switch lost delivery, destination agent, or working directory")
	}
	if _, err := s.AcknowledgeHarness(ctx, id, in.ID); err != nil {
		t.Fatal(err)
	}
	waitFor("Codex completing the unfinished file task", func() bool {
		result, _ := os.ReadFile(filepath.Join(folder, "result.txt"))
		return string(result) == seed
	})
	waitFor("translated Codex assistant reply", func() bool {
		events, _ := conversation.Read(s.SessionLog(id), int64(len(source)))
		for _, ev := range events {
			if ev.Message != nil && ev.Message.Role == "assistant" {
				for _, block := range ev.Message.Content {
					if strings.Contains(block.Text, "HANDOFF_DONE") {
						return true
					}
				}
			}
		}
		return false
	})
	turns := s.userTurns(id)
	if _, err := s.SwitchHarness(ctx, id, in); err != nil {
		t.Fatal(err)
	}
	if s.userTurns(id) != turns || turns != 1 {
		t.Fatal("retry duplicated the continuation")
	}
	journal, _ := os.ReadFile(s.SessionLog(id))
	if !bytes.HasPrefix(journal, source) {
		t.Fatal("original history or byte cursors changed")
	}
	s.endSummary(id)
	restarted := NewService(s.Root)
	if _, err := restarted.SwitchHarness(ctx, id, in); err != nil {
		t.Fatal(err)
	}
	if restarted.userTurns(id) != turns {
		t.Fatal("service restart duplicated the continuation")
	}
	if kept, _ := os.ReadFile(filepath.Join(folder, "seed.txt")); string(kept) != seed {
		t.Fatal("source workspace file changed")
	}
	if run(t, folder, "branch", "--show-current") != branch || run(t, folder, "rev-parse", "HEAD") != head {
		t.Fatal("handoff changed the git branch or original commit")
	}
	t.Log("Real Claude → Codex handoff completed: same workspace, exact history prefix, file continuity, one continuation across retry and restart")
}

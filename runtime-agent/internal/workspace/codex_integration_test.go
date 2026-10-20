package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/tmux"
)

// TestCodexSessionEndToEnd drives a REAL `codex` in a real tmux session through
// the Service: create a Codex session on an OpenAI key (its own Codex home,
// logged in, its folder trusted), start it, send a prompt, and assert the
// prompt was recorded in the rollout and the translated conversation (what
// SessionLog gives the conversation stream) receives the assistant's reply.
//
// Opt-in, since it spends tokens: set CODEX_BIN to a codex binary and
// OPENAI_API_KEY to a key (CODEX_MODEL picks a model, for a key whose
// account limits the default's). tmux must be on PATH, or named by
// RUNTIME_TMUX_BIN (the desktop app ships one); a private server keeps the
// test off the user's own:
//
//	CODEX_BIN=$(which codex) OPENAI_API_KEY=sk-... \
//	RUNTIME_TMUX_BIN=/Applications/Outrunner.app/Contents/MacOS/tmux RUNTIME_TMUX_SOCKET=codex-itest \
//	go test ./internal/workspace/ -run TestCodexSessionEndToEnd -v
func TestCodexSessionEndToEnd(t *testing.T) {
	bin, key := os.Getenv("CODEX_BIN"), os.Getenv("OPENAI_API_KEY")
	if bin == "" || key == "" {
		t.Skip("set CODEX_BIN and OPENAI_API_KEY to run this integration test")
	}
	if _, err := exec.LookPath(tmux.Program()); err != nil {
		t.Skipf("no tmux (%s): set RUNTIME_TMUX_BIN", tmux.Program())
	}
	// The agent's environment is read once, at NewService: codex first on
	// PATH, and a home of the test's own so nothing of the user's is read.
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("HOME", t.TempDir())
	ctx := context.Background()
	s := NewService(t.TempDir())
	const id = "codex-itest"
	if _, err := s.Create(ctx, CreateInput{
		WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(),
		Agent: AgentCodex, Model: os.Getenv("CODEX_MODEL"),
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.SetAuth(ctx, id, AuthOpenAIAPIKey, key); err != nil {
		t.Fatalf("SetAuth: %v", err)
	}
	t.Cleanup(func() { _ = s.Destroy(context.Background(), id) })

	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if pane, _ := s.tmux.CapturePane(ctx, sessionName(id)); !isCodexComposer(pane) {
		t.Fatalf("Start returned before Codex's prompt box showed:\n%s", pane)
	}
	if err := s.SendMessage(id, "Reply with exactly the word: pong"); err != nil {
		pane, _ := s.tmux.CapturePane(ctx, sessionName(id))
		t.Fatalf("SendMessage: %v\n%s", err, pane)
	}
	if got := s.userTurns(id); got != 1 {
		t.Errorf("user turns in the rollout = %d, want 1", got)
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if log := s.SessionLog(id); log != "" {
			data, _ := os.ReadFile(log)
			if strings.Contains(string(data), `"role":"assistant"`) && strings.Contains(string(data), `"type":"text"`) {
				t.Logf("translated conversation:\n%s", strings.TrimSpace(string(data)))
				return
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	pane, _ := s.tmux.CapturePane(ctx, sessionName(id))
	t.Fatalf("no assistant reply in the translated conversation within the timeout; SessionLog=%q\n%s", s.SessionLog(id), pane)
}

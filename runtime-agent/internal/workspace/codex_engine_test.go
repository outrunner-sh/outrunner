package workspace

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/codex/codextest"
)

func TestMain(m *testing.M) {
	codextest.Main() // this binary, run as the stand-in Codex app server
	os.Exit(m.Run())
}

// startedCodexSession creates a Codex session on a folder of its own, its app server
// the stand-in, and starts it.
func startedCodexSession(t *testing.T) (*Service, *fakeSessions, string) {
	t.Helper()
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	s.tmux = fake
	s.codex = newCodexEngine(os.Args[0], codextest.Env(), s.Root)
	const id = "ws-codex"
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), Agent: AgentCodex}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = s.Stop(context.Background(), id) })
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return s, fake, id
}

// waitForConversation waits for the session's log to hold want, and returns it.
func waitForConversation(t *testing.T, s *Service, id, want string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, _ := os.ReadFile(s.SessionLog(id))
		if strings.Contains(string(data), want) {
			return string(data)
		}
		if time.Now().After(deadline) {
			t.Fatalf("the conversation never showed %q:\n%s", want, data)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestACodexSessionTakesAPromptAndWritesItsConversation(t *testing.T) {
	t.Parallel()
	s, fake, id := startedCodexSession(t)
	f, _ := s.getFacts(id)
	// No model asked for: the login's default, not whatever config.toml says.
	if f.CodexThreadID == "" || f.Model != "fake-default" {
		t.Fatalf("facts after Start: thread %q, model %q", f.CodexThreadID, f.Model)
	}
	if err := s.SendMessage(id, "list the files"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	log := waitForConversation(t, s, id, "echo: list the files (fake-default)")
	for _, want := range []string{`"type":"user"`, `"content":"list the files"`, `"name":"Bash"`, `"command":"ls"`, `"model":"fake-default"`} {
		if !strings.Contains(log, want) {
			t.Errorf("conversation lacks %s:\n%s", want, log)
		}
	}
	// The terminal has a shell to attach to, in the session's folder.
	if len(fake.launches) != 1 || !strings.HasSuffix(fake.launches[0][len(fake.launches[0])-1], "-l") {
		t.Errorf("shell launches = %q", fake.launches)
	}
	if !s.SessionAlive(context.Background(), id) {
		t.Error("a running Codex session reads as not alive")
	}
}

func TestACodexModelChangeTakesTheNextTurn(t *testing.T) {
	t.Parallel()
	s, _, id := startedCodexSession(t)
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "fake-other"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if err := s.SendMessage(id, "again"); err != nil {
		t.Fatal(err)
	}
	waitForConversation(t, s, id, "echo: again (fake-other)")
	// A gateway is Claude's alone.
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "m", Gateway: "openrouter", Token: strings.Repeat("k", 30)}, ""); !errors.Is(err, ErrModelUnsupported) {
		t.Errorf("gateway on Codex = %v, want ErrModelUnsupported", err)
	}
}

func TestACodexSessionResumesItsThreadAfterAStop(t *testing.T) {
	t.Parallel()
	s, _, id := startedCodexSession(t)
	before, _ := s.getFacts(id)
	if err := s.Stop(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if s.codex.Active(id) {
		t.Fatal("Codex still running after Stop")
	}
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start again: %v", err)
	}
	after, _ := s.getFacts(id)
	if after.CodexThreadID != before.CodexThreadID {
		t.Errorf("thread %q after restart, want %q resumed", after.CodexThreadID, before.CodexThreadID)
	}
}

func TestAFailedCodexTurnSaysWhyInTheChat(t *testing.T) {
	t.Parallel()
	s, _, id := startedCodexSession(t)
	if err := s.SendMessage(id, "FAIL please"); err != nil {
		t.Fatal(err)
	}
	waitForConversation(t, s, id, "Codex stopped: The 'x' model is not supported.")
	// The session carries on after a failed turn.
	if err := s.SendMessage(id, "and now"); err != nil {
		t.Fatal(err)
	}
	waitForConversation(t, s, id, "echo: and now (fake-default)")
}

func TestCodexAsksAreDeclined(t *testing.T) {
	t.Parallel()
	s, _, id := startedCodexSession(t)
	if err := s.SendMessage(id, "ASK to run something"); err != nil {
		t.Fatal(err)
	}
	waitForConversation(t, s, id, `approval={\"decision\":\"decline\"}`)
}

func TestCodexIsOnlyForThisMacAndAKnownAgent(t *testing.T) {
	t.Parallel()
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	ctx := context.Background()
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-a", Branch: "b", BaseBranch: "main", Agent: AgentCodex}); !errors.Is(err, ErrCodexLocalOnly) {
		t.Errorf("Codex on a Runtime Computer = %v, want ErrCodexLocalOnly", err)
	}
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-b", Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), Agent: "gemini"}); !errors.Is(err, ErrUnknownAgent) {
		t.Errorf("unknown agent = %v, want ErrUnknownAgent", err)
	}
}

func TestASessionsAgentNeverChanges(t *testing.T) {
	t.Parallel()
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	ctx := context.Background()
	folder := t.TempDir()
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-c", Branch: "b", BaseBranch: "main", RepoPath: folder, Agent: AgentCodex}); err != nil {
		t.Fatal(err)
	}
	// Re-created after an agent restart, by a caller that doesn't say.
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-c", Branch: "b", BaseBranch: "main", RepoPath: folder}); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws-c"); f.Agent != AgentCodex {
		t.Errorf("agent after re-create = %q", f.Agent)
	}
}

func TestCodexModelsComeFromCodexAndAreReused(t *testing.T) {
	t.Parallel()
	s := NewService(t.TempDir())
	s.codex = newCodexEngine(os.Args[0], codextest.Env(), s.Root)
	models, err := s.CodexModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "fake-default" || !models[0].IsDefault {
		t.Fatalf("models = %+v", models)
	}
	// Asked again within minutes: the same list, without starting Codex again.
	s.codex.bin = "/nonexistent/codex"
	if again, err := s.CodexModels(context.Background()); err != nil || len(again) != 2 {
		t.Errorf("second ask = %+v, %v; want the cached list", again, err)
	}
}

package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/redact"
)

// The user's answer to a session's request is kept for the session, owner
// only, sourced by its next launch and masked; the agent is told the names,
// never a value; a value nobody asked for is refused.
func TestProvidedSecretsReachTheSessionAndAreMasked(t *testing.T) {
	s := NewService(t.TempDir())
	req := ask.SecretRequest{Reason: "Deploy", Keys: []ask.SecretKey{{Name: "VERCEL_TOKEN"}, {Name: "VERCEL_ORG", Optional: true}}}
	result := make(chan string, 1)
	go func() {
		text, err := s.RequestSecrets(context.Background(), "ws1", "r1", req)
		if err != nil {
			t.Errorf("RequestSecrets: %v", err)
		}
		result <- text
	}()
	waitUntil(t, func() bool { return s.secretAsks.Waiting("ws1") })
	if err := s.ProvideSecrets("ws1", []string{"NOPE"}, nil, false); !errors.Is(err, ask.ErrNotWaiting) {
		t.Fatalf("an answer to another request = %v, want ErrNotWaiting", err)
	}

	names := []string{"VERCEL_TOKEN", "VERCEL_ORG"}
	if err := s.ProvideSecrets("ws1", names, map[string]string{"VERCEL_TOKEN": "tok-abc'123", "OTHER": "x"}, false); !errors.Is(err, ErrInvalidEnvironment) {
		t.Fatalf("a value nobody asked for = %v, want ErrInvalidEnvironment", err)
	}
	if err := s.ProvideSecrets("ws1", names, map[string]string{"VERCEL_TOKEN": "a\x00b"}, false); err == nil || !strings.Contains(err.Error(), "NUL") {
		t.Fatalf("a NUL = %v, want it named", err)
	}
	if err := s.ProvideSecrets("ws1", names, map[string]string{"VERCEL_ORG": "org"}, false); !errors.Is(err, ErrInvalidEnvironment) {
		t.Fatalf("without the required one = %v, want ErrInvalidEnvironment", err)
	}
	if err := s.ProvideSecrets("ws1", names, map[string]string{"VERCEL_TOKEN": "tok-abc'123"}, false); err != nil {
		t.Fatal(err)
	}
	text := <-result
	if !strings.Contains(text, "provided VERCEL_TOKEN.") || !strings.Contains(text, "left out VERCEL_ORG") || strings.Contains(text, "tok-abc") {
		t.Errorf("result = %q", text)
	}

	path := s.ProvidedEnvPath("ws1")
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("provided file: %v %v", info, err)
	}
	out, err := exec.Command("sh", "-c", `. "$1" && printf '%s' "$VERCEL_TOKEN"`, "sh", path).Output()
	if err != nil || string(out) != "tok-abc'123" {
		t.Errorf("sourced %q (%v)", out, err)
	}
	if !slices.Contains(s.RedactionSecrets(), "tok-abc'123") {
		t.Error("a provided value isn't masked")
	}
	// A terminal open before it was provided masks it too.
	open := redact.New(nil).Follow(s.LiveSecrets())
	if got := open.Redact([]byte("token is tok-abc'123!")) + open.Flush(); got != "token is ***!" {
		t.Errorf("an open terminal shows %q", got)
	}
	if argv := s.launchCommand("ws1", t.TempDir(), false); !slices.Contains(argv, path) {
		t.Errorf("launch = %q, want it to source %s", argv, path)
	}

	// A second request adds to the first's.
	go func() {
		_, _ = s.RequestSecrets(context.Background(), "ws1", "r2", ask.SecretRequest{Reason: "x", Keys: []ask.SecretKey{{Name: "NPM_TOKEN"}}})
	}()
	waitUntil(t, func() bool { return s.secretAsks.Waiting("ws1") })
	if err := s.ProvideSecrets("ws1", []string{"NPM_TOKEN"}, map[string]string{"NPM_TOKEN": "npm-1"}, false); err != nil {
		t.Fatal(err)
	}
	if all := s.provided("ws1"); all["VERCEL_TOKEN"] != "tok-abc'123" || all["NPM_TOKEN"] != "npm-1" {
		t.Errorf("provided = %v", all)
	}

	s.removeProvided("ws1")
	if fileExists(path) || len(s.provided("ws1")) != 0 {
		t.Error("a destroyed session's secrets are still there")
	}
	// Nor are they kept in memory for the terminals that follow the list.
	if got := redact.New(nil).Follow(s.LiveSecrets()).Redact([]byte("tok-abc'123")); !strings.Contains(got, "tok-abc") {
		t.Errorf("a destroyed session's value is still masked: %q", got)
	}
}

func TestASkippedRequestKeepsNothing(t *testing.T) {
	s := NewService(t.TempDir())
	result := make(chan string, 1)
	go func() {
		text, _ := s.RequestSecrets(context.Background(), "ws1", "r1", ask.SecretRequest{Reason: "x", Keys: []ask.SecretKey{{Name: "A_KEY"}}})
		result <- text
	}()
	waitUntil(t, func() bool { return s.secretAsks.Waiting("ws1") })
	if err := s.ProvideSecrets("ws1", []string{"A_KEY"}, nil, true); err != nil {
		t.Fatal(err)
	}
	if text := <-result; !strings.Contains(text, "skipped") || fileExists(s.ProvidedEnvPath("ws1")) {
		t.Errorf("result %q, file kept: %v", text, fileExists(s.ProvidedEnvPath("ws1")))
	}
}

// Claude owns CLAUDE_ENV_FILE; our settings append source commands to it.
func TestAClaudeLaunchLoadsTheEnvironmentThroughAHook(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-s", Branch: "b", BaseBranch: "main"})
	s.RelayExecutable = "/opt/runtime-agent"
	argv := claudeAgent{s}.command("ws-s", worktree, false)
	if argv[0] != "claude" || strings.Contains(strings.Join(argv, " "), "CLAUDE_ENV_FILE=") {
		t.Fatalf("launch overrides Claude's hook env file: %q", argv)
	}
	i := slices.Index(argv, "--settings")
	if i < 0 || strings.Count(strings.Join(argv, " "), "--settings ") != 1 {
		t.Fatalf("launch = %q, want one --settings", argv)
	}
	if !slices.Contains(argv, ask.QualifiedSecretsToolName) {
		t.Errorf("launch = %q, want the tool allowed", argv)
	}
	data, _ := os.ReadFile(argv[i+1])
	if !strings.Contains(string(data), `"SessionStart"`) || !strings.Contains(string(data), "$CLAUDE_ENV_FILE") {
		t.Errorf("settings = %s", data)
	}
}

func TestSecretsSettingsKeepTheUsersOwn(t *testing.T) {
	user := map[string]any{
		"model": "x",
		"hooks": map[string]any{"SessionStart": []any{map[string]any{"hooks": []any{"theirs"}}}, "Stop": []any{"stop"}},
	}
	got := secretsSettings("/r/env/ws.env", "/r/provided/ws.env", user)
	data, _ := json.Marshal(got)
	hooks := got["hooks"].(map[string]any)
	if got["model"] != "x" || len(hooks["SessionStart"].([]any)) != 2 || hooks["Stop"] == nil {
		t.Errorf("settings = %s", data)
	}
	if len(user["hooks"].(map[string]any)["SessionStart"].([]any)) != 1 {
		t.Error("the user's settings were changed")
	}
}

func TestClaudeHookLoadsProjectAndNewSecretsInAnAlreadyRunningSession(t *testing.T) {
	s := NewService(filepath.Join(t.TempDir(), "root with 'quotes"))
	project := s.envFiles().path("ws")
	provided := s.ProvidedEnvPath("ws")
	if err := s.SetEnvironment(context.Background(), "ws", map[string]string{"PROJECT_TOKEN": "project-'token", "OVERRIDE": "old"}, nil, ""); err != nil {
		t.Fatal(err)
	}
	settings := secretsSettings(project, provided, nil)
	hooks := settings["hooks"].(map[string]any)["SessionStart"].([]any)
	command := hooks[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string)
	hookEnv := filepath.Join(t.TempDir(), "claude-hook.env")
	if err := os.WriteFile(hookEnv, []byte("export USER_HOOK=kept\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", command)
	cmd.Env = append(os.Environ(), "CLAUDE_ENV_FILE="+hookEnv)
	if out, err := cmd.CombinedOutput(); err != nil || len(out) != 0 {
		t.Fatalf("hook = %q, %v", out, err)
	}
	// As Claude does, cache the hook env contents once, then use that same
	// script before each Bash call. Initially no supplied file exists.
	preamble, err := os.ReadFile(hookEnv)
	if err != nil {
		t.Fatal(err)
	}
	bash := func(want string) {
		t.Helper()
		cmd := exec.Command("bash", "-c", string(preamble)+`printf '%s|%s|%s|%s' "$USER_HOOK" "$PROJECT_TOKEN" "${NEW_TOKEN-unset}" "$OVERRIDE"`)
		out, err := cmd.CombinedOutput()
		if err != nil || string(out) != want {
			t.Fatalf("Bash saw %q, %v; want %q", out, err, want)
		}
	}
	bash("kept|project-'token|unset|old")
	if err := s.addProvided("ws", map[string]string{"NEW_TOKEN": "new-'secret", "OVERRIDE": "provided"}); err != nil {
		t.Fatal(err)
	}
	bash("kept|project-'token|new-'secret|provided")
	if err := s.SetEnvironment(context.Background(), "ws", map[string]string{"PROJECT_TOKEN": "changed", "OVERRIDE": "old"}, nil, ""); err != nil {
		t.Fatal(err)
	}
	bash("kept|changed|new-'secret|provided")
}

func TestProjectEnvironmentIsDescribedAndLoadedWithoutAnAskRelay(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-e", Branch: "b", BaseBranch: "main"})
	if err := s.SetEnvironment(context.Background(), "ws-e", map[string]string{"PROJECT_TOKEN": "private-value"}, nil, ""); err != nil {
		t.Fatal(err)
	}
	argv := claudeAgent{s}.command("ws-e", worktree, false)
	if !slices.Contains(argv, "--settings") {
		t.Fatalf("project environment has no Bash hook: %q", argv)
	}
	note := s.orientation("ws-e", worktree)
	if !strings.Contains(note, "Available variables: PROJECT_TOKEN") || strings.Contains(note, "private-value") {
		t.Fatalf("orientation doesn't describe variable names safely: %q", note)
	}
}

func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/ask"
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

// A Claude launch with the tools names the provided file as CLAUDE_ENV_FILE
// and gets one settings file: the user's, with the hooks that watch it.
func TestAClaudeLaunchWatchesTheProvidedFile(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-s", Branch: "b", BaseBranch: "main"})
	s.RelayExecutable = "/opt/runtime-agent"
	argv := claudeAgent{s}.command("ws-s", worktree, false)
	path := s.ProvidedEnvPath("ws-s")
	if len(argv) < 3 || argv[0] != "env" || argv[1] != "CLAUDE_ENV_FILE="+path || argv[2] != "claude" {
		t.Fatalf("launch = %q, want env CLAUDE_ENV_FILE=%s claude ...", argv, path)
	}
	if !fileExists(path) {
		t.Error("no provided file for Claude to watch")
	}
	i := slices.Index(argv, "--settings")
	if i < 0 || strings.Count(strings.Join(argv, " "), "--settings ") != 1 {
		t.Fatalf("launch = %q, want one --settings", argv)
	}
	if !slices.Contains(argv, ask.QualifiedSecretsToolName) {
		t.Errorf("launch = %q, want the tool allowed", argv)
	}
	data, _ := os.ReadFile(argv[i+1])
	if !strings.Contains(string(data), `\"watchPaths\":[\"`+path) || !strings.Contains(string(data), `"FileChanged"`) {
		t.Errorf("settings = %s", data)
	}
}

func TestSecretsSettingsKeepTheUsersOwn(t *testing.T) {
	user := map[string]any{
		"model": "x",
		"hooks": map[string]any{"SessionStart": []any{map[string]any{"hooks": []any{"theirs"}}}, "Stop": []any{"stop"}},
	}
	got := secretsSettings("/r/provided/ws.env", user)
	data, _ := json.Marshal(got)
	hooks := got["hooks"].(map[string]any)
	if got["model"] != "x" || len(hooks["SessionStart"].([]any)) != 2 || hooks["Stop"] == nil || hooks["FileChanged"] == nil {
		t.Errorf("settings = %s", data)
	}
	// The user's own map is left as it was.
	if len(user["hooks"].(map[string]any)["SessionStart"].([]any)) != 1 {
		t.Error("the user's settings were changed")
	}
	// The SessionStart hook prints the JSON Claude reads.
	cmd := hooks["SessionStart"].([]any)[1].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string)
	out, err := exec.Command("sh", "-c", cmd).Output()
	var printed struct {
		HookSpecificOutput struct {
			HookEventName string   `json:"hookEventName"`
			WatchPaths    []string `json:"watchPaths"`
		} `json:"hookSpecificOutput"`
	}
	if err != nil || json.Unmarshal(out, &printed) != nil || printed.HookSpecificOutput.HookEventName != "SessionStart" ||
		!slices.Equal(printed.HookSpecificOutput.WatchPaths, []string{"/r/provided/ws.env"}) {
		t.Errorf("hook printed %q (%v)", out, err)
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

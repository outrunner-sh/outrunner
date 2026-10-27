package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A session's environment reaches its launch before its credential, is
// owner-only on disk, and its secret-length values are masked; what it can't
// set is refused.
func TestEnvironmentIsSourcedFirstAndMasked(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws1", workspaceFacts{Branch: "b", Auth: AuthAnthropicAPIKey})
	env := map[string]string{"DATABASE_URL": "postgres://u:p@db/app's", "NODE_ENV": "production"}
	if err := s.SetEnvironment(context.Background(), "ws1", env, nil, ""); err != nil {
		t.Fatal(err)
	}

	path := s.envFiles().path("ws1")
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("environment file mode = %v (%v), want 0600", info.Mode().Perm(), err)
	}
	argv := s.launchCommand("ws1", t.TempDir(), false)
	if len(argv) < 10 || argv[4] != path || argv[9] != s.authFiles().path("ws1") {
		t.Errorf("launch = %q, want the environment sourced before the credential's file", argv)
	}
	// Sourcing it gives the values back exactly, quote included.
	out, err := exec.Command("sh", "-c", `. "$1" && printf '%s|%s' "$DATABASE_URL" "$NODE_ENV"`, "sh", path).Output()
	if err != nil || string(out) != "postgres://u:p@db/app's|production" {
		t.Errorf("sourced %q (%v)", out, err)
	}
	secrets := strings.Join(s.RedactionSecrets(), "\n")
	if !strings.Contains(secrets, "postgres://u:p@db/app") || strings.Contains(secrets, "production") {
		t.Errorf("masked %q: want the URL, not the short setting", secrets)
	}

	for _, name := range []string{"PATH", "ANTHROPIC_API_KEY", "RUNTIME_AGENT_SECRET", "1BAD", "A-B"} {
		err := s.SetEnvironment(context.Background(), "ws1", map[string]string{name: "x"}, nil, "")
		if !errors.Is(err, ErrInvalidEnvironment) {
			t.Errorf("%s accepted (%v)", name, err)
		}
	}
}

// The setup script runs once, in the worktree, with the session's variables.
func TestSetupRunsOnceWithTheEnvironment(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws1", workspaceFacts{Branch: "b"})
	worktree := t.TempDir()
	// As a Conductor setup script does: link a .env from the root checkout.
	setup := `printf '%s' "$API_TOKEN" > token.txt; echo ran >> runs.txt; mkdir -p api && ln -sf "$CONDUCTOR_ROOT_PATH/api/.env" api/.env`
	files := map[string]string{"api/.env": "SECRET=from-the-root-checkout\n"}
	if err := s.SetEnvironment(context.Background(), "ws1", map[string]string{"API_TOKEN": "tok-123"}, files, setup); err != nil {
		t.Fatal(err)
	}

	s.startSetup("ws1", worktree, os.Environ())
	s.startSetup("ws1", worktree, os.Environ()) // a relaunch

	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(readFile(s.setupLogPath("ws1")), "setup finished") {
		if time.Now().After(deadline) {
			t.Fatalf("setup never finished; log:\n%s", readFile(s.setupLogPath("ws1")))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := readFile(filepath.Join(worktree, "token.txt")); got != "tok-123" {
		t.Errorf("setup saw API_TOKEN=%q", got)
	}
	if got := readFile(filepath.Join(worktree, "runs.txt")); got != "ran\n" {
		t.Errorf("setup ran %q, want once", got)
	}
	if got := readFile(filepath.Join(worktree, "api", ".env")); got != "SECRET=from-the-root-checkout\n" {
		t.Errorf("linked .env reads %q", got)
	}
	if !strings.Contains(strings.Join(s.RedactionSecrets(), "\n"), "from-the-root-checkout") {
		t.Error("a value in a session's files is not masked")
	}
}

// With no setup script, a session's files are copied into its worktree once;
// one already there is kept, and a path out of the folder is refused.
func TestFilesWithoutSetupAreCopiedOnce(t *testing.T) {
	s := NewService(t.TempDir())
	worktree := t.TempDir()
	if err := os.WriteFile(filepath.Join(worktree, ".env.local"), []byte("MINE=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{".env": "A=1\n", ".env.local": "THEIRS=1\n", "web/.env": "B=2\n"}
	if err := s.SetEnvironment(context.Background(), "ws1", nil, files, ""); err != nil {
		t.Fatal(err)
	}
	s.startSetup("ws1", worktree, os.Environ())
	for path, want := range map[string]string{".env": "A=1\n", ".env.local": "MINE=1\n", "web/.env": "B=2\n"} {
		if got := readFile(filepath.Join(worktree, path)); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
	if err := os.Remove(filepath.Join(worktree, ".env")); err != nil {
		t.Fatal(err)
	}
	s.startSetup("ws1", worktree, os.Environ())
	if fileExists(filepath.Join(worktree, ".env")) {
		t.Error("a removed file came back on relaunch")
	}
	for _, bad := range []string{"../outside", "/etc/passwd", "a/../../b", "./x"} {
		if err := s.SetEnvironment(context.Background(), "ws1", nil, map[string]string{bad: "x"}, ""); !errors.Is(err, ErrInvalidEnvironment) {
			t.Errorf("file %q accepted (%v)", bad, err)
		}
	}
}

func readFile(path string) string {
	data, _ := os.ReadFile(path)
	return string(data)
}

// The variables refused here are the ones the control plane leaves out of an
// import (lib/imports/environment.ts): both match the shared list.
func TestReservedEnvMatchesTheSharedList(t *testing.T) {
	dir, _ := os.Getwd()
	for !fileExists(filepath.Join(dir, "lib", "runtime", "agent-protocol.fixtures.json")) {
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("agent-protocol.fixtures.json not found")
		}
		dir = parent
	}
	var fixtures struct {
		ReservedEnv [][]string `json:"ReservedEnv"`
	}
	data, err := os.ReadFile(filepath.Join(dir, "lib", "runtime", "agent-protocol.fixtures.json"))
	if err != nil || json.Unmarshal(data, &fixtures) != nil || len(fixtures.ReservedEnv) != 1 {
		t.Fatalf("read the shared list: %v", err)
	}
	shared := map[string]bool{}
	for _, name := range fixtures.ReservedEnv[0] {
		shared[name] = true
	}
	if !reflect.DeepEqual(shared, reservedEnv) {
		t.Errorf("reservedEnv = %v, the shared list = %v", reservedEnv, shared)
	}
}

// A project's instructions follow Outrunner's orientation at every launch,
// until they are taken away; too much is refused.
func TestInstructionsFollowTheOrientation(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws1", workspaceFacts{Branch: "b", BaseBranch: "main"})
	wt := t.TempDir()
	plain := s.orientation("ws1", wt)

	if err := s.SetInstructions("ws1", "  Use pnpm. Run pnpm test before a PR.\n"); err != nil {
		t.Fatal(err)
	}
	o := s.orientation("ws1", wt)
	if !strings.HasPrefix(o, plain) || !strings.HasSuffix(o, "\n\nUse pnpm. Run pnpm test before a PR.") {
		t.Errorf("orientation = %q, want the instructions after %q", o, plain)
	}
	if info, err := os.Stat(s.instructionsPath("ws1")); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("instructions file: %v %v", info, err)
	}

	if err := s.SetInstructions("ws1", ""); err != nil {
		t.Fatal(err)
	}
	if o := s.orientation("ws1", wt); o != plain {
		t.Errorf("orientation after removing = %q, want %q", o, plain)
	}
	// Measured in bytes: 16 KB of characters that take three bytes each is
	// three times too much.
	tooLarge := strings.Repeat("界", maxInstructionsBytes/3+1)
	if err := ValidInstructions(tooLarge); !errors.Is(err, ErrInvalidEnvironment) {
		t.Errorf("ValidInstructions(too large) = %v, want ErrInvalidEnvironment", err)
	}
	if err := s.SetInstructions("ws1", tooLarge); !errors.Is(err, ErrInvalidEnvironment) {
		t.Errorf("too large: %v, want ErrInvalidEnvironment", err)
	}
}

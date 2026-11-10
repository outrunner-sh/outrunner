package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/redact"
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

func TestWorthMaskingTellsKeysFromSettings(t *testing.T) {
	for _, c := range []struct {
		name, value string
		want        bool
	}{
		{"DB_PASS", "s3cr3tPw", true},
		{"STRIPE_KEY", "sk_9x8y7z", true},
		{"SOME_NAME", "a-long-setting-name", true},
		{"AWS_REGION", "us-east-1", false},
		{"RUNTIME", "postgres16", false},
		{"NODE_ENV", "production", false},
		{"PORT", "8080", false},
		{"API_TOKEN", "short", false},
	} {
		if got := worthMasking(c.name, c.value); got != c.want {
			t.Errorf("worthMasking(%q, %q) = %v, want %v", c.name, c.value, got, c.want)
		}
	}
}

func TestFileTokensReadsJSONAndPEMFiles(t *testing.T) {
	account := `{"type":"service_account","private_key_id":"0a1b2c3d4e","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n","client_id":"104523988123456789012","token_uri":"https://oauth2.googleapis.com/token"}`
	got := fileTokens(account)
	for _, want := range []string{"0a1b2c3d4e", "104523988123456789012", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n"} {
		if !slices.Contains(got, want) {
			t.Errorf("JSON file tokens %q lack %q", got, want)
		}
	}
	if slices.Contains(got, "service_account") || slices.Contains(got, "https://oauth2.googleapis.com/token") {
		t.Errorf("JSON file tokens took a setting: %q", got)
	}
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n"
	if got := fileTokens(pem); len(got) != 1 || got[0] != strings.TrimSpace(pem) {
		t.Errorf("PEM file tokens = %q", got)
	}
	// A last line of base64 padded with = reads as an assignment.
	padded := "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CHHkqTxBBYXLhZwOo\nAwEHoUQDQgAE=\n-----END EC PRIVATE KEY-----\n"
	if got := fileTokens(padded); len(got) != 1 || got[0] != strings.TrimSpace(padded) {
		t.Errorf("padded PEM file tokens = %q", got)
	}
	if got := fileTokens("PORT=8080\nAWS_REGION=us-east-1\nDB_PASS=s3cr3tPw\n"); !reflect.DeepEqual(got, []string{"s3cr3tPw"}) {
		t.Errorf(".env file tokens = %q", got)
	}
	// A .env with a key inline keeps its other variables masked.
	inline := "NODE_ENV=production\nAPP_NAME=myservice\nAPI_KEY=sk_live_abcdef1234567890\nPRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\"\n"
	key := "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----"
	// Double-quoted, and single-quoted over several lines (the dotenv
	// parser reads one line of that): the key is masked either way, and
	// the settings beside it stay readable.
	for _, file := range []string{inline, strings.ReplaceAll(inline, `"`, `'`)} {
		got := fileTokens(file)
		if !slices.Contains(got, "sk_live_abcdef1234567890") || !slices.Contains(got, key) || slices.Contains(got, "-----BEGIN PRIVATE KEY-----") {
			t.Errorf("inline-key .env tokens = %q", got)
		}
		r := redact.New(got)
		if masked := r.Text("env: NODE_ENV=production and APP_NAME=myservice, MIIEvQIBADANBgkq"); masked != "env: NODE_ENV=production and APP_NAME=myservice, ***" {
			t.Errorf("masked = %q", masked)
		}
	}
	// A block left open masks the whole file: alone, after a closed one, or
	// before one (where its body would run into the next key's block).
	closed := "A_KEY=\"-----BEGIN PRIVATE KEY-----\nAAAABBBBCCCCDDDD\n-----END PRIVATE KEY-----\"\n"
	open := "B_KEY='-----BEGIN EC PRIVATE KEY-----\nEEEEFFFFGGGGHHHH\n'\n"
	for file, want := range map[string]string{
		open:          "x AAAABBBBCCCCDDDD ***",
		closed + open: "x *** ***",
		open + closed: "x *** ***",
	} {
		got := fileTokens(file)
		if len(got) != 1 || got[0] != strings.TrimSpace(file) {
			t.Errorf("open block tokens = %q", got)
		}
		if masked := redact.New(got).Text("x AAAABBBBCCCCDDDD EEEEFFFFGGGGHHHH"); masked != want {
			t.Errorf("open block masked = %q, want %q", masked, want)
		}
	}
	// Every label RFC 7468 allows, not only RSA/EC: an OpenSSH key, and one
	// with a hyphen inside, masked as its block beside a readable setting.
	ssh := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
	if got := fileTokens(ssh); len(got) != 1 || got[0] != strings.TrimSpace(ssh) {
		t.Errorf("OpenSSH key tokens = %q", got)
	}
	hyphened := "-----BEGIN X-TEST PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END X-TEST PRIVATE KEY-----"
	if got := fileTokens("NODE_ENV=production\nKEY=\"" + hyphened + "\"\n"); !slices.Contains(got, hyphened) || slices.Contains(got, "production") {
		t.Errorf("hyphenated label tokens = %q", got)
	}
	for armor, want := range map[string]bool{
		"X-TEST PRIVATE KEY": true,
		"":                   true, // RFC 7468 allows an empty label
		"-LEADING":           false,
		"DOUBLE--HYPHEN":     false,
		// A trailing hyphen runs into the armor's dashes and matches: the
		// block is masked all the same.
		"TRAIL-": true,
	} {
		block := "-----BEGIN " + armor + "-----\nx\n-----END " + armor + "-----"
		if got := pemBlock.MatchString(block); got != want {
			t.Errorf("pemBlock matches label %q: %v, want %v", armor, got, want)
		}
	}
}

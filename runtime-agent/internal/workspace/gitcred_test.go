package workspace

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/redact"
)

// gitCredentialService is a service whose sessions get their GitHub tokens
// from a stand-in control plane, launched with base as its environment and
// exe as its own binary. It hands out ghs_1, ghs_2, … in turn.
func gitCredentialService(t *testing.T, base []string, exe string) (*Service, *atomic.Int32) {
	t.Helper()
	var fetches atomic.Int32
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := fetches.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_app_token_` + string(rune('0'+n)) + `","expiresAt":"2999-01-01T00:00:00Z","identity":"app"}`))
	}))
	t.Cleanup(cp.Close)
	s := NewService(t.TempDir())
	s.env, s.secrets = sessionEnvironment(base)
	s.RelayExecutable = exe
	client := &gitcred.Client{Config: gitcred.Config{AppURL: cp.URL, SandboxID: "sbx", Secret: "secret"}, HTTP: cp.Client()}
	if err := s.UseGitCredential(client); err != nil {
		t.Fatal(err)
	}
	return s, &fetches
}

// The launch variables that turn the feature on are the agent's, not the
// sessions'; without them, nothing else changes (the GitHub token's own
// config, TestSessionEnvironmentGivesGitTheGitHubTokenForGitHubOnly).
func TestSessionEnvironmentDropsTheCredentialLaunchVariables(t *testing.T) {
	env, _ := sessionEnvironment([]string{"PATH=/usr/bin", "RUNTIME_SANDBOX_ID=sbx", "OUTRUNNER_APP_URL=https://app.outrunner.sh", "RUNTIME_MEMORY_AUTOSCALING=1"})
	if !slices.Equal(env, []string{"PATH=/usr/bin"}) {
		t.Fatalf("env = %q", env)
	}
	s := NewService(t.TempDir())
	if s.GitCredentialEnabled() {
		t.Fatal("on without UseGitCredential")
	}
	if _, err := s.GitCredential(context.Background(), ""); err == nil {
		t.Fatal("a token without UseGitCredential")
	}
}

// git asks this binary for github.com's credentials, naming the repository,
// in place of the launch token's config and any the box had; the launch
// token stays, for the helpers to fall back on. Run through real git, with
// a stand-in binary at a path that needs quoting.
func TestUseGitCredentialPointsGitAtTheAgent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "it's here")
	exe := filepath.Join(dir, "runtime-agent")
	record := filepath.Join(t.TempDir(), "calls")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\necho \"$*\" >> " + gitcred.ShellQuote(record) + "\ncat >> " + gitcred.ShellQuote(record) + "\necho username=x-access-token\necho password=ghs_from_helper\n"
	if err := os.WriteFile(exe, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	s, _ := gitCredentialService(t, []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + t.TempDir(),
		"GH_TOKEN=gho_user",
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=credential.helper",
		"GIT_CONFIG_VALUE_0=!echo password=the-box-own",
		"GIT_CONFIG_KEY_1=user.name",
		"GIT_CONFIG_VALUE_1=box",
	}, exe)
	env := s.SessionEnv()
	if !slices.Contains(env, "GH_TOKEN=gho_user") || !slices.Contains(s.RedactionSecrets(), "gho_user") {
		t.Fatalf("the launch token isn't kept and masked: %q", env)
	}
	var gitConfig []string
	for _, entry := range env {
		if strings.HasPrefix(entry, "GIT_CONFIG_") {
			gitConfig = append(gitConfig, entry)
		}
	}
	want := []string{
		"GIT_CONFIG_COUNT=3",
		"GIT_CONFIG_KEY_0=credential.https://github.com.helper",
		"GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=credential.https://github.com.helper",
		"GIT_CONFIG_VALUE_1=!'" + strings.ReplaceAll(exe, "'", `'\''`) + "' git-credential --root '" + s.Root + "'",
		"GIT_CONFIG_KEY_2=credential.https://github.com.useHttpPath",
		"GIT_CONFIG_VALUE_2=true",
	}
	if !slices.Equal(gitConfig, want) {
		t.Fatalf("git config = %q, want %q", gitConfig, want)
	}
	if path := envValue(env, "PATH"); path != s.gitBinDir()+":"+os.Getenv("PATH") {
		t.Fatalf("PATH = %q", path)
	}

	// The box's own git config has a helper for github.com already (gh's
	// `auth setup-git`, say), which mustn't answer first.
	global := filepath.Join(t.TempDir(), "gitconfig")
	stale := "[credential \"https://github.com\"]\n\thelper = \"!f() { echo username=x; echo password=stale; }; f\"\n"
	if err := os.WriteFile(global, []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}
	fill := func(url string) string {
		cmd := exec.Command("git", "credential", "fill")
		cmd.Env = append(env, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+global)
		cmd.Stdin = strings.NewReader("url=" + url + "\n\n")
		out, _ := cmd.Output()
		return string(out)
	}
	if got := fill("https://github.com/acme/widgets.git"); !strings.Contains(got, "password=ghs_from_helper") {
		t.Fatalf("git did not get the agent's token: %q", got)
	}
	calls, _ := os.ReadFile(record)
	if !strings.HasPrefix(string(calls), "git-credential --root "+s.Root+" get\n") || !strings.Contains(string(calls), "path=acme/widgets.git\n") {
		t.Fatalf("git ran the helper as %q", calls)
	}
	_ = os.Remove(record)
	if got := fill("https://example.com/acme/widgets.git"); strings.Contains(got, "ghs_from_helper") {
		t.Fatalf("git asked the helper for another host: %q", got)
	}
	if _, err := os.Stat(record); err == nil {
		t.Fatal("git ran the helper for another host")
	}
}

// The helpers' token is made at start, owner-only, and is the only one let
// in.
func TestGitCredentialToken(t *testing.T) {
	s, _ := gitCredentialService(t, []string{"PATH=/usr/bin"}, "/bin/runtime-agent")
	_, tokenFile := GitCredentialPaths(s.Root)
	info, err := os.Stat(tokenFile)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("token file: %v %v", info, err)
	}
	data, _ := os.ReadFile(tokenFile)
	token := strings.TrimSpace(string(data))
	if len(token) != 64 || !s.GitCredentialAuthorized(token) || s.GitCredentialAuthorized("") || s.GitCredentialAuthorized(token+"x") {
		t.Fatalf("token %q not the one authorized", token)
	}
	if !s.GitCredentialEnabled() {
		t.Fatal("not on")
	}
}

// Without an executable for git to run, the sessions keep their launch
// token's config.
func TestUseGitCredentialNeedsTheExecutable(t *testing.T) {
	s := NewService(t.TempDir())
	before := s.SessionEnv()
	if err := s.UseGitCredential(&gitcred.Client{}); err == nil {
		t.Fatal("on without an executable")
	}
	if !slices.Equal(before, s.SessionEnv()) || s.GitCredentialEnabled() {
		t.Fatal("the environment changed")
	}
}

// gh on the box gets the wrapper, which runs it; a box without gh gets none,
// and a wrapper left from when it had one goes.
func TestUseGitCredentialWrapsGh(t *testing.T) {
	bin := t.TempDir()
	realGh := filepath.Join(bin, "gh")
	if err := os.WriteFile(realGh, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, _ := gitCredentialService(t, []string{"PATH=" + bin + ":/usr/bin"}, "/opt/runtime-agent")
	wrapper := filepath.Join(s.gitBinDir(), "gh")
	data, err := os.ReadFile(wrapper)
	if err != nil || string(data) != gitcred.GhWrapper("/opt/runtime-agent", s.Root, realGh) {
		t.Fatalf("wrapper = %q, %v", data, err)
	}
	if info, _ := os.Stat(wrapper); info.Mode().Perm() != 0o755 {
		t.Fatalf("wrapper mode = %v", info.Mode())
	}

	// Started again on a box with the wrapper on its own PATH, and no gh.
	s.env = []string{"PATH=" + s.gitBinDir() + ":/nonexistent"}
	if err := s.UseGitCredential(&gitcred.Client{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wrapper); !os.IsNotExist(err) {
		t.Fatalf("the stale wrapper is still there: %v", err)
	}
	if path := envValue(s.env, "PATH"); path != s.gitBinDir()+":/nonexistent" {
		t.Fatalf("PATH = %q", path)
	}
}

// Every token handed out is masked: in the terminals opened after, and in
// those already open, whatever happens to the provided secrets meanwhile.
func TestGitCredentialTokensAreMasked(t *testing.T) {
	s, fetches := gitCredentialService(t, []string{"PATH=/usr/bin"}, "/bin/runtime-agent")
	open := redact.New(s.RedactionSecrets()).Follow(s.LiveSecrets())
	cred, err := s.GitCredential(context.Background(), "acme/widgets")
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := s.GitCredential(context.Background(), "ACME/widgets"); again.Token != cred.Token || fetches.Load() != 1 {
		t.Fatalf("not cached: %q after %d fetches", again.Token, fetches.Load())
	}
	if !slices.Contains(s.RedactionSecrets(), cred.Token) {
		t.Fatal("not among the redaction secrets")
	}
	if got := open.Redact([]byte("push with "+cred.Token+"!")) + open.Flush(); got != "push with ***!" {
		t.Fatalf("an open terminal shows %q", got)
	}

	if err := s.addProvided("ws1", map[string]string{"API_KEY": "provided-123"}); err != nil {
		t.Fatal(err)
	}
	s.refreshLiveSecrets()
	s.removeProvided("ws2")
	if got := open.Redact([]byte(cred.Token+" provided-123 ")) + open.Flush(); got != "*** *** " {
		t.Fatalf("after the provided secrets changed, an open terminal shows %q", got)
	}

	if err := s.EraseGitCredential("acme/widgets"); err != nil {
		t.Fatal(err)
	}
	if next, _ := s.GitCredential(context.Background(), "acme/widgets"); next.Token == cred.Token || fetches.Load() != 2 {
		t.Fatalf("erase kept the token: %q", next.Token)
	}
}

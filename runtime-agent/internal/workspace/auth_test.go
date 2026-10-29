package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"runtime-agent/internal/claude"
)

const (
	testOAuthToken  = "sk-ant-oat01-session-0123456789abcdef"
	testAnthropic   = "sk-ant-api03-session-0123456789abcdef"
	testOpenAIKey   = "sk-proj-session-0123456789abcdef"
	testGatewayKey2 = "sk-or-v1-gateway-0123456789abcdef"
)

// loginRecorder stands in for `codex login`, recording how it was run.
type loginRecorder struct {
	mu    sync.Mutex
	calls []loginCall
	err   error
	out   string
}

type loginCall struct {
	env   []string
	stdin string
	argv  []string
}

func (l *loginRecorder) run(_ context.Context, env []string, stdin string, argv ...string) ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, loginCall{env: env, stdin: stdin, argv: argv})
	return []byte(l.out), l.err
}

func TestASessionsCredentialFitsItsAgent(t *testing.T) {
	for _, c := range []struct {
		agent, kind, token string
		wantErr            error
		exports            []string
	}{
		{AgentClaude, AuthClaudeOAuthToken, testOAuthToken, nil,
			[]string{"unset ANTHROPIC_API_KEY", "export CLAUDE_CODE_OAUTH_TOKEN='" + testOAuthToken + "'"}},
		{AgentClaude, AuthAnthropicAPIKey, testAnthropic, nil,
			[]string{"unset CLAUDE_CODE_OAUTH_TOKEN", "export ANTHROPIC_API_KEY='" + testAnthropic + "'"}},
		{"", AuthAnthropicAPIKey, testAnthropic, nil, // a session recorded before agents is Claude's
			[]string{"export ANTHROPIC_API_KEY='" + testAnthropic + "'"}},
		{AgentClaude, AuthOpenAIAPIKey, testOpenAIKey, ErrAuthMismatch, nil},
		{AgentClaude, AuthCodexAccessToken, testOpenAIKey, ErrAuthMismatch, nil},
		{AgentCodex, AuthCodexAccessToken, "synthetic-workspace-access-token", nil, []string{"unset OPENAI_API_KEY", "export CODEX_ACCESS_TOKEN='synthetic-workspace-access-token'"}},
		{AgentCodex, AuthOpenAIAPIKey, testOpenAIKey, nil, []string{"export OPENAI_API_KEY='" + testOpenAIKey + "'"}},
		{AgentCodex, AuthClaudeOAuthToken, testOAuthToken, ErrAuthMismatch, nil},
		{AgentCodex, AuthAnthropicAPIKey, testAnthropic, ErrAuthMismatch, nil},
	} {
		t.Run(c.agent+"/"+c.kind, func(t *testing.T) {
			s := NewService(t.TempDir())
			if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws-k", Branch: "b", RepoPath: t.TempDir(), Agent: c.agent}); err != nil {
				t.Fatal(err)
			}
			err := s.SetAuth(context.Background(), "ws-k", c.kind, c.token)
			if !errors.Is(err, c.wantErr) {
				t.Fatalf("SetAuth = %v, want %v", err, c.wantErr)
			}
			path := s.authFiles().path("ws-k")
			if c.wantErr != nil {
				if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
					t.Errorf("a refused credential was written: %v", statErr)
				}
				if f, _ := s.getFacts("ws-k"); f.Auth != "" {
					t.Errorf("a refused credential was recorded: %q", f.Auth)
				}
				return
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("credential file = %v, %v; want it owner-only", info, err)
			}
			content := s.authFiles().read("ws-k")
			for _, line := range c.exports {
				if !strings.Contains(content, line+"\n") {
					t.Errorf("credential file lacks %q:\n%s", line, content)
				}
			}
			if f, _ := s.getFacts("ws-k"); f.Auth != c.kind {
				t.Errorf("recorded kind = %q, want %q", f.Auth, c.kind)
			}
			if !slices.Contains(s.RedactionSecrets(), c.token) || !slices.Contains(NewService(s.Root).RedactionSecrets(), c.token) {
				t.Error("the credential isn't masked (or isn't after a restart)")
			}
		})
	}
}

func TestSetAuthOnAnUnknownWorkspaceWritesNothing(t *testing.T) {
	s := NewService(t.TempDir())
	if err := s.SetAuth(context.Background(), "ws-none", AuthOpenAIAPIKey, testOpenAIKey); !errors.Is(err, ErrUnknownWorkspace) {
		t.Fatalf("SetAuth = %v, want ErrUnknownWorkspace", err)
	}
	if _, err := os.Stat(s.authFiles().path("ws-none")); !os.IsNotExist(err) {
		t.Errorf("a credential was written for a workspace never created: %v", err)
	}
}

// The session's credential is sourced before a gateway's file, so with both
// the gateway's key is what Claude runs on: run the launch for real, with a
// shell in Claude's place printing what it would see.
func TestAGatewayWinsOverTheSessionsOwnCredential(t *testing.T) {
	s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-both", Branch: "b", BaseBranch: "main"})
	ctx := context.Background()
	if err := s.SetAuth(ctx, "ws-both", AuthAnthropicAPIKey, testAnthropic); err != nil {
		t.Fatalf("SetAuth: %v", err)
	}
	argv := s.launchCommand("ws-both", wt, false)
	if want := []string{"sh", "-c", `. "$1" && shift && exec "$@"`, "sh", s.authFiles().path("ws-both"), "claude"}; !slices.Equal(argv[:len(want)], want) {
		t.Fatalf("launch = %q, want claude run after sourcing the credential", argv)
	}
	if err := s.SetModel(ctx, "ws-both", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: testGatewayKey2}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	argv = s.launchCommand("ws-both", wt, false)
	i := slices.Index(argv, "claude")
	if i < 0 {
		t.Fatalf("launch = %q, no claude", argv)
	}
	if strings.Contains(strings.Join(argv, " "), testAnthropic) || strings.Contains(strings.Join(argv, " "), testGatewayKey2) {
		t.Fatalf("a key is on the command line: %q", argv)
	}
	probe := append(argv[:i:i], "sh", "-c", `printf '%s|%s|%s' "${CLAUDE_CODE_OAUTH_TOKEN-unset}" "${ANTHROPIC_API_KEY-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}"`)
	cmd := exec.Command(probe[0], probe[1:]...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "CLAUDE_CODE_OAUTH_TOKEN=from-the-agent"}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("running the launch: %v", err)
	}
	if got, want := string(out), "unset||"+testGatewayKey2; got != want {
		t.Errorf("Claude would see %q, want %q (the gateway's key, nothing else)", got, want)
	}
}

func TestTakingACredentialAwayKeepsItMaskedUntilTheSessionIsForgotten(t *testing.T) {
	s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-n", Branch: "b", BaseBranch: "main"})
	ctx := context.Background()
	if err := s.SetAuth(ctx, "ws-n", AuthClaudeOAuthToken, testOAuthToken); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAuth(ctx, "ws-n", AuthNone, ""); err != nil {
		t.Fatalf("SetAuth none: %v", err)
	}
	if _, err := os.Stat(s.authFiles().path("ws-n")); !os.IsNotExist(err) {
		t.Errorf("the credential file outlived none: %v", err)
	}
	if f, _ := s.getFacts("ws-n"); f.Auth != "" {
		t.Errorf("recorded kind after none = %q", f.Auth)
	}
	if argv := s.launchCommand("ws-n", wt, false); argv[0] != "claude" {
		t.Errorf("launch after none = %q, want claude on its own login", argv)
	}
	// The conversation it continues can still redraw the token.
	if !slices.Contains(s.RedactionSecrets(), testOAuthToken) {
		t.Error("a credential taken away is no longer masked")
	}
	s.forgetWorkspace("ws-n")
	if slices.Contains(s.RedactionSecrets(), testOAuthToken) {
		t.Error("a forgotten session's credential is still masked")
	}
	if files, _ := filepath.Glob(filepath.Join(s.Root, "auth", "*")); len(files) != 0 {
		t.Errorf("a forgotten session's credential files remain: %q", files)
	}
}

func TestASessionWhoseCredentialFileIsGoneRefusesToLaunch(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	if err := s.SetAuth(context.Background(), id, AuthAnthropicAPIKey, testAnthropic); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(s.authFiles().path(id)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(context.Background(), id, ""); !errors.Is(err, ErrAuthMissing) {
		t.Errorf("Start = %v, want ErrAuthMissing", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("launched without its credential: %q", fake.launches)
	}
}

func TestACodexSessionWithAKeyRunsInItsOwnLoggedInHome(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-key", Branch: "b", BaseBranch: "main"})
	login := &loginRecorder{}
	s.runCommand = login.run
	s.env = []string{"PATH=/usr/bin", "OPENAI_API_KEY=the-computers-key", "CODEX_HOME=/Users/user/.codex"}
	ctx := context.Background()
	if err := s.SetAuth(ctx, id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatalf("SetAuth: %v", err)
	}
	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	home := s.codexHome(id)
	if info, err := os.Stat(home); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("Codex home = %v, %v; want it owner-only", info, err)
	}
	config, _ := os.ReadFile(filepath.Join(home, "config.toml"))
	folder, _ := filepath.EvalSymlinks(s.worktreePath(id))
	for _, want := range []string{`cli_auth_credentials_store = "file"`, `[projects."` + folder + `"]`, `trust_level = "trusted"`} {
		if !strings.Contains(string(config), want) {
			t.Errorf("config.toml lacks %q:\n%s", want, config)
		}
	}
	if len(login.calls) != 1 {
		t.Fatalf("codex login ran %d times, want once", len(login.calls))
	}
	call := login.calls[0]
	if !slices.Equal(call.argv, []string{"codex", "login", "--with-api-key"}) || call.stdin != testOpenAIKey+"\n" {
		t.Errorf("login = %q with stdin %q, want the key on stdin", call.argv, call.stdin)
	}
	if !slices.Contains(call.env, "CODEX_HOME="+home) || slices.Contains(call.env, "CODEX_HOME=/Users/user/.codex") || slices.Contains(call.env, "OPENAI_API_KEY=the-computers-key") {
		t.Errorf("login env = %q, want only the session's home", call.env)
	}
	want := []string{"env", "-u", "OPENAI_API_KEY", "-u", "CODEX_ACCESS_TOKEN", "CODEX_HOME=" + home, "codex"}
	if got := fake.lastLaunch(); !slices.Equal(got[:len(want)], want) || strings.Contains(strings.Join(got, " "), testOpenAIKey) {
		t.Errorf("launch = %q, want codex in its own home, the key off the command line", got)
	}
	if !slices.Contains(s.RedactionSecrets(), testOpenAIKey) {
		t.Error("the OpenAI key is not masked")
	}

	// Without the key again, Codex runs in the user's home, and the session's
	// home keeps no copy of the key.
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"OPENAI_API_KEY":"`+testOpenAIKey+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAuth(ctx, id, AuthNone, ""); err != nil {
		t.Fatalf("SetAuth none: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
		t.Errorf("the session's Codex home kept the key: %v", err)
	}
	if got := s.launchCommand(id, s.worktreePath(id), false); got[0] != "codex" {
		t.Errorf("launch without a key = %q, want codex in the user's home", got)
	}
	s.forgetWorkspace(id)
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("a forgotten session's Codex home remains: %v", err)
	}
}

func TestACodexLoginThatFailsLaunchesNothingAndHidesTheKey(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-key", Branch: "b", BaseBranch: "main"})
	s.runCommand = (&loginRecorder{err: errors.New("exit status 1"), out: "Error: invalid key " + testOpenAIKey}).run
	if err := s.SetAuth(context.Background(), id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	_, err := s.Start(context.Background(), id, "")
	if err == nil || !strings.Contains(err.Error(), "codex login") || strings.Contains(err.Error(), testOpenAIKey) {
		t.Fatalf("Start = %v, want the login failure without the key", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("launched after a failed login: %q", fake.launches)
	}
}

func TestACodexSessionWithoutAKeyUsesTheUsersOwnLogin(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-local", Branch: "b", BaseBranch: "main"})
	login := &loginRecorder{}
	s.runCommand = login.run
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(login.calls) != 0 {
		t.Errorf("logged in without a key: %+v", login.calls)
	}
	if got := fake.lastLaunch(); got[0] != "codex" {
		t.Errorf("launch = %q, want codex in the user's own home", got)
	}
	if _, err := os.Stat(s.codexHome(id)); !os.IsNotExist(err) {
		t.Errorf("a home of its own was made: %v", err)
	}
}

func TestTheComputersOpenAIKeyIsMasked(t *testing.T) {
	_, secrets := sessionEnvironment([]string{"OPENAI_API_KEY=sk-proj-computer", "PATH=/usr/bin"})
	if !slices.Contains(secrets, "sk-proj-computer") {
		t.Errorf("secrets = %q, want the OpenAI key", secrets)
	}
}

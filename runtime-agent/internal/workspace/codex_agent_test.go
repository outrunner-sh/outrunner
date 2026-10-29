package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"runtime-agent/internal/claude"
)

// codexPane reads a pane as codex-cli 0.146.0 drew it in tmux (captured into
// testdata/codex, paths redacted).
func codexPane(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "codex", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCodexPaneReaders(t *testing.T) {
	a := codexAgent{}
	for _, c := range []struct {
		pane                 string
		composer, menu, busy bool
		key                  string
	}{
		{"trust.txt", false, true, false, "Enter"},
		{"composer.txt", true, false, false, ""},
		{"ready-trusted.txt", true, false, false, ""},
		// A Codex home of the session's own, logged in with a key and
		// trusting the folder in its config.toml: no trust question at all.
		{"own-home-ready.txt", true, false, false, ""},
		{"typed.txt", true, false, false, ""},
		{"run-1.txt", true, false, true, ""},
		{"run-8.txt", true, false, true, ""}, // reconnecting after a rate limit
		{"tool-3.txt", true, false, true, ""},
		{"tool-11.txt", true, false, false, ""},
		{"approve-1.txt", true, false, true, ""},
		{"approve-2.txt", false, true, false, ""}, // "Would you like to run the following command?"
		{"after-approve.txt", true, false, false, ""},
		// Codex hides its status line while it streams a reply: it reads idle.
		{"busy-streaming.txt", true, false, false, ""},
		{"interrupted.txt", true, false, false, ""},
		{"resumed.txt", true, false, false, ""},
		{"error-final.txt", true, false, true, ""},
	} {
		pane := codexPane(t, c.pane)
		if got := a.isComposer(pane); got != c.composer {
			t.Errorf("%s: isComposer = %v, want %v", c.pane, got, c.composer)
		}
		if got := a.awaitsAnswer(pane); got != c.menu {
			t.Errorf("%s: awaitsAnswer = %v, want %v", c.pane, got, c.menu)
		}
		if got := a.isBusy(pane); got != c.busy {
			t.Errorf("%s: isBusy = %v, want %v", c.pane, got, c.busy)
		}
		if got := a.startupKey(pane); got != c.key {
			t.Errorf("%s: startupKey = %q, want %q", c.pane, got, c.key)
		}
	}
}

func TestCodexTrustKeyNeverMeansNo(t *testing.T) {
	const question = "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.\n\n"
	a := codexAgent{}
	for _, c := range []struct{ name, pane, want string }{
		{"No selected, Yes above", question + "  1. Yes, continue\n› 2. No, quit\n\n  Press enter to continue", "Up"},
		{"Yes selected", question + "› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue", "Enter"},
		// Options it doesn't know: nothing pressed, since any key could quit.
		{"other wording", question + "› 1. Sure\n  2. Nope\n\n  Press enter to continue", ""},
		{"no selection drawn yet", question + "  1. Yes, continue\n  2. No, quit", ""},
		// A login menu is the user's to answer.
		{"login", "  Sign in with ChatGPT to use Codex\n\n› 1. Sign in with ChatGPT\n  2. Provide your own API key\n\n  Press enter to continue", ""},
	} {
		if got := a.startupKey(c.pane); got != c.want {
			t.Errorf("%s: startupKey = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestCodexComposerEdges(t *testing.T) {
	const footer = "\n\n  gpt-6-luna default · /work/repo\n\n\n"
	for _, c := range []struct {
		name     string
		pane     string
		composer bool
		menu     bool
	}{
		{"a prompt typed over several lines", "› fix the login\n  and the tests" + footer, true, false},
		{"a numbered prompt typed", "› 1. fix the login" + footer, true, false},
		{"a numbered prompt over several lines", "› 1. fix the login\n  2. and the tests" + footer, true, false},
		// History above, a menu below: the › of the history is not the box.
		{"history over a menu", "› Run curl\n• Running curl\n› 1. Yes, proceed (y)\n  2. No (esc)\n\n  Press enter to confirm or esc to cancel", false, true},
		{"output over the footer", "› Run curl\n• 200 · OK" + footer, false, false},
		{"blank", "", false, false},
	} {
		if got := isCodexComposer(c.pane); got != c.composer {
			t.Errorf("%s: isCodexComposer = %v, want %v", c.name, got, c.composer)
		}
		if got := codexAwaitsAnswer(c.pane); got != c.menu {
			t.Errorf("%s: codexAwaitsAnswer = %v, want %v", c.name, got, c.menu)
		}
	}
}

// codexSession creates a Codex session in a folder of its own (in place), with
// a codex binary to find.
func codexSession(t *testing.T, in CreateInput) (*Service, *fakeSessions, string) {
	t.Helper()
	s := NewService(t.TempDir())
	s.lookPath = func(string) (string, error) { return "/usr/local/bin/codex", nil }
	fake := newFakeSessions()
	fake.pane = codexPane(t, "ready-trusted.txt")
	s.tmux = fake
	in.Agent = AgentCodex
	if in.RepoPath == "" {
		in.RepoPath = t.TempDir()
	}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { s.stopRecorder(context.Background(), in.WorkspaceID) })
	return s, fake, in.WorkspaceID
}

func TestACodexSessionLaunchesCodexAndTrustsItsFolder(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main", Model: "gpt-6-luna"})
	trust, ready := codexPane(t, "trust.txt"), codexPane(t, "ready-trusted.txt")
	fake.pane = trust
	fake.onKey = func(key string) string {
		if key == "Enter" {
			return ready
		}
		return ""
	}
	if _, err := s.Start(context.Background(), id, "sk-ant-oat01-not-for-codex"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	got := fake.lastLaunch()
	if len(got) < 3 || got[0] != "codex" || got[1] != "-m" || got[2] != "gpt-6-luna" || !slices.Contains(got, "on-request") {
		t.Errorf("launch = %q, want codex on its model, acceptEdits mapped", got)
	}
	if !strings.Contains(strings.Join(got, " "), "developer_instructions=\"You are working inside Outrunner") {
		t.Errorf("launch = %q, want the orientation as developer instructions", got)
	}
	if !slices.Equal(fake.keys, []string{"Enter"}) {
		t.Errorf("keys pressed = %q, want one Enter on Yes", fake.keys)
	}
	if f, _ := s.getFacts(id); f.ClaudeSessionID != "" {
		t.Errorf("a Codex session got a Claude conversation id: %+v", f)
	}
}

func TestACodexSessionResumesItsConversationById(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main"})
	f, _ := s.getFacts(id)
	f.CodexSessionID = "01a1596f-41f4-7f30-88f4-b569d1b5bf76"
	s.setFacts(id, f)
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := fake.lastLaunch(); len(got) < 3 || got[1] != "resume" || got[2] != f.CodexSessionID {
		t.Errorf("launch = %q, want codex resume <id>", got)
	}
}

func TestACodexSessionWithoutCodexSaysHowToInstallIt(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main"})
	s.lookPath = func(string) (string, error) { return "", errors.New("not found") }
	_, err := s.Start(context.Background(), id, "")
	if !errors.Is(err, ErrCodexMissing) || !strings.Contains(err.Error(), "npm install -g @openai/codex") {
		t.Fatalf("Start = %v, want ErrCodexMissing with the install command", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("launched without codex: %q", fake.launches)
	}
	// A running session asked to switch keeps running: the check comes first.
	fake.running[sessionName(id)] = true
	if err := s.SetModel(context.Background(), id, ModelChoice{Model: "gpt-5.5"}, ""); !errors.Is(err, ErrCodexMissing) {
		t.Fatalf("SetModel = %v, want ErrCodexMissing", err)
	}
	if !fake.HasSession(context.Background(), sessionName(id)) {
		t.Error("a switch that couldn't launch Codex killed the running session")
	}
}

func TestACodexThatExitsAtOnceSaysToRunCodex(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main"})
	fake.exitAtOnce = true
	_, err := s.Start(context.Background(), id, "")
	if !errors.Is(err, errCodexExited) || !strings.Contains(err.Error(), "run `codex`") {
		t.Fatalf("Start = %v, want errCodexExited pointing at codex", err)
	}
}

func TestACodexSessionSwitchesModelsAndOnlyThroughOpenRouter(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main", Model: "gpt-6-luna"})
	fake.running[sessionName(id)] = true
	ctx := context.Background()
	// Anthropic's API, and the others serving only it, mean nothing to Codex.
	for _, g := range []claude.Gateway{claude.Anthropic, "zai", "moonshot", "deepseek"} {
		err := s.SetModel(ctx, id, ModelChoice{Model: "glm-5.3", Gateway: g, Token: testGatewayKey2}, "")
		if !errors.Is(err, ErrGatewayUnsupported) {
			t.Fatalf("SetModel through %s = %v, want ErrGatewayUnsupported", g, err)
		}
	}
	if _, statErr := os.Stat(s.gatewayEnvPath(id)); !os.IsNotExist(statErr) || len(fake.launches) != 0 {
		t.Fatalf("a refused gateway left a key file (%v) or relaunched (%q)", statErr, fake.launches)
	}
	if err := s.SetModel(ctx, id, ModelChoice{Model: "gpt-5.5"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if got := fake.lastLaunch(); len(got) < 3 || got[0] != "codex" || got[2] != "gpt-5.5" {
		t.Errorf("relaunch = %q, want codex -m gpt-5.5", got)
	}
}

// Outrunner's models in Codex: through OpenRouter's Responses API, from a
// Codex home of the session's own whose config holds the key, which is on no
// command line and in no environment.
func TestACodexSessionOnOpenRouterRunsInItsOwnHomeOnTheKey(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-or", Branch: "b", BaseBranch: "main", Model: "gpt-5.5"})
	login := &loginRecorder{}
	s.runCommand = login.run
	s.env = []string{"PATH=/usr/bin", "OPENAI_API_KEY=the-computers-key", "CODEX_HOME=/home/runtime/.codex"}
	ctx := context.Background()
	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	fake.running[sessionName(id)] = true
	if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: testGatewayKey2}, ""); err != nil {
		t.Fatalf("SetModel onto OpenRouter: %v", err)
	}
	home := s.codexHome(id)
	argv := fake.lastLaunch()
	want := []string{"env", "-u", "OPENAI_API_KEY", "CODEX_HOME=" + home, "codex", "-m", "z-ai/glm-5.3"}
	if len(argv) < len(want) || !slices.Equal(argv[:len(want)], want) {
		t.Fatalf("relaunch = %q, want codex on GLM in its own home", argv)
	}
	if strings.Contains(strings.Join(argv, " "), testGatewayKey2) ||
		strings.Contains(strings.Join(s.agentFor(id).env(""), " "), testGatewayKey2) {
		t.Errorf("the key is on the command line or in the environment: %q", argv)
	}
	if !strings.Contains(strings.Join(argv, " "), "you are Outrunner") || !strings.Contains(strings.Join(argv, " "), "calls you Codex") {
		t.Errorf("launch = %q, want Outrunner's identity in Codex's terms", argv)
	}
	if info, err := os.Stat(home); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("Codex home = %v, %v; want it owner-only", info, err)
	}
	configPath := filepath.Join(home, "config.toml")
	if info, err := os.Stat(configPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config.toml = %v, %v; want it owner-only", info, err)
	}
	config := readFileString(t, configPath)
	for _, line := range []string{`model_provider = "openrouter"`, `base_url = "https://openrouter.ai/api/v1"`,
		`wire_api = "responses"`, `experimental_bearer_token = "` + testGatewayKey2 + `"`, `trust_level = "trusted"`} {
		if !strings.Contains(config, line) {
			t.Errorf("config.toml lacks %q:\n%s", line, config)
		}
	}
	// TOML: the provider's top-level key must come before every table.
	if strings.Index(config, "model_provider =") > strings.Index(config, "[") {
		t.Errorf("model_provider follows a table, where Codex reads it as the table's:\n%s", config)
	}
	if len(login.calls) != 0 {
		t.Errorf("logged in with no OpenAI key: %+v", login.calls)
	}
	if info, err := os.Stat(s.gatewayEnvPath(id)); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("key file = %v, %v; want it owner-only", info, err)
	}
	if !slices.Contains(s.RedactionSecrets(), testGatewayKey2) {
		t.Error("the gateway key is not masked")
	}

	// A relaunch (a resume after an exit, a restarted agent) goes back on it.
	s2 := NewService(s.Root)
	s2.lookPath, s2.tmux, s2.runCommand, s2.env = s.lookPath, fake, login.run, s.env
	if _, err := s2.Resume(ctx, id, ""); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if got := fake.lastLaunch(); !slices.Equal(got[:len(want)], want) {
		t.Errorf("relaunch after a restart = %q, want codex on GLM in its own home", got)
	}
	if !strings.Contains(readFileString(t, configPath), testGatewayKey2) {
		t.Error("the relaunch lost the provider")
	}

	// A replaced key is the one the next launch runs on; the old stays masked.
	const replaced = "sk-or-v1-replaced-0123456789abcdef"
	if err := s2.SetModel(ctx, id, ModelChoice{Model: "moonshotai/kimi-k3", Gateway: claude.OpenRouter, Token: replaced}, ""); err != nil {
		t.Fatalf("SetModel onto Kimi: %v", err)
	}
	if config := readFileString(t, configPath); !strings.Contains(config, replaced) || strings.Contains(config, testGatewayKey2) {
		t.Errorf("config.toml after the key changed:\n%s", config)
	}
	if secrets := s2.RedactionSecrets(); !slices.Contains(secrets, replaced) || !slices.Contains(secrets, testGatewayKey2) {
		t.Error("the new key, or the one it replaced, is not masked")
	}

	// Back on OpenAI's models with no key of its own: the user's home, and the
	// session's keeps no copy of the gateway's key.
	if err := s2.SetModel(ctx, id, ModelChoice{Model: "gpt-5.5"}, ""); err != nil {
		t.Fatalf("SetModel off the gateway: %v", err)
	}
	if got := fake.lastLaunch(); got[0] != "codex" {
		t.Errorf("relaunch = %q, want codex in the user's own home", got)
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Errorf("the session's Codex home kept the gateway's key: %v", err)
	}
}

// A Codex session with its own OpenAI key and on a gateway: logged in, so a
// switch back to OpenAI's models needs nothing more, and on the gateway.
func TestACodexSessionWithAKeyAndAGatewayIsOnBoth(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-both", Branch: "b", BaseBranch: "main"})
	login := &loginRecorder{}
	s.runCommand = login.run
	ctx := context.Background()
	if err := s.SetAuth(ctx, id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if err := s.SetModel(ctx, id, ModelChoice{Model: "deepseek/deepseek-v4.1-flash", Gateway: claude.OpenRouter, Token: testGatewayKey2}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(login.calls) != 1 {
		t.Errorf("codex login ran %d times, want once", len(login.calls))
	}
	config := readFileString(t, filepath.Join(s.codexHome(id), "config.toml"))
	if !strings.Contains(config, `cli_auth_credentials_store = "file"`) || !strings.Contains(config, testGatewayKey2) {
		t.Errorf("config.toml:\n%s", config)
	}
	if argv := strings.Join(fake.lastLaunch(), " "); strings.Contains(argv, testGatewayKey2) || strings.Contains(argv, testOpenAIKey) {
		t.Errorf("a key is on the command line: %s", argv)
	}
}

// A gateway-only session logs its home in with nothing, even if an OpenAI key
// it no longer claims was left in its file: whether it logs in is the
// session's facts' to say, not whatever file survived.
func TestACodexSessionOnAGatewayAloneNeverLogsInWithAStaleKey(t *testing.T) {
	t.Parallel()
	s, _, id := codexSession(t, CreateInput{WorkspaceID: "ws-stale", Branch: "b", BaseBranch: "main"})
	login := &loginRecorder{}
	s.runCommand = login.run
	ctx := context.Background()
	if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: testGatewayKey2}, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.authFiles().put(id, authEnvFile(AuthOpenAIAPIKey, testOpenAIKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(login.calls) != 0 {
		t.Errorf("logged in with a key the session doesn't claim: %+v", login.calls)
	}
}

// A session recorded on the gateway whose key file is gone doesn't launch on
// whatever the computer has.
func TestACodexSessionWithoutItsGatewayKeyDoesntLaunch(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-gone", Branch: "b", BaseBranch: "main"})
	ctx := context.Background()
	if err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: testGatewayKey2}, ""); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(s.gatewayEnvPath(id)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, id, ""); !errors.Is(err, ErrGatewayKeyMissing) {
		t.Fatalf("Start = %v, want ErrGatewayKeyMissing", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("launched without its key: %q", fake.launches)
	}
}

func TestARepeatedCreateNeverChangesTheAgent(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	folder := t.TempDir()
	ctx := context.Background()
	s := NewService(root)
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-a", Branch: "b", RepoPath: folder, Agent: AgentCodex}); err != nil {
		t.Fatal(err)
	}
	// After a restart, the control plane re-creates naming another agent (or none).
	for _, agent := range []string{AgentClaude, ""} {
		if _, err := NewService(root).Create(ctx, CreateInput{WorkspaceID: "ws-a", Branch: "b", RepoPath: folder, Agent: agent}); err != nil {
			t.Fatal(err)
		}
		if f, _ := NewService(root).getFacts("ws-a"); f.Agent != AgentCodex {
			t.Errorf("re-Create naming %q switched the agent to %q", agent, f.Agent)
		}
	}
	// A session recorded before agents is Claude's, and stays so.
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-old", Branch: "b", RepoPath: folder}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws-old", Branch: "b", RepoPath: folder, Agent: AgentCodex}); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.agentFor("ws-old").(claudeAgent); !ok {
		t.Error("a Claude session became a Codex one on a repeated Create")
	}
	if !ValidAgent("") || !ValidAgent("claude") || !ValidAgent("codex") || ValidAgent("gemini") || ValidAgent("Codex") {
		t.Error("ValidAgent accepts the wrong names")
	}
}

func TestTheJcodeEngineNeitherOffersNorTakesCodex(t *testing.T) {
	s := NewService(t.TempDir())
	s.lookPath = func(string) (string, error) { return "/usr/local/bin/codex", nil }
	if err := s.CheckAgent(AgentCodex); err != nil {
		t.Fatalf("CheckAgent(codex) on the tmux engine = %v", err)
	}
	if !slices.Contains(s.Agents(), AgentCodex) {
		t.Fatalf("Agents = %q, want codex offered where it's installed", s.Agents())
	}
	// The jcode engine runs its own sessions: a Codex one would run jcode.
	s.jcode = &jcodeEngine{}
	if slices.Contains(s.Agents(), AgentCodex) {
		t.Errorf("Agents on jcode = %q, want no codex", s.Agents())
	}
	if err := s.CheckAgent(AgentCodex); !errors.Is(err, ErrAgentUnsupported) {
		t.Errorf("CheckAgent(codex) on jcode = %v, want ErrAgentUnsupported", err)
	}
	for _, name := range []string{"", AgentClaude} {
		if err := s.CheckAgent(name); err != nil {
			t.Errorf("CheckAgent(%q) on jcode = %v", name, err)
		}
	}
	if err := s.CheckAgent("gemini"); err == nil {
		t.Error("an unknown agent was taken")
	}
}

func TestTheJcodeEngineTakesNoSessionCredential(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws-j", workspaceFacts{Agent: AgentClaude})
	s.jcode = &jcodeEngine{}
	err := s.SetAuth(context.Background(), "ws-j", AuthAnthropicAPIKey, "sk-ant-api03-"+strings.Repeat("a", 30))
	if !errors.Is(err, ErrAuthUnsupported) {
		t.Fatalf("SetAuth on jcode = %v, want ErrAuthUnsupported", err)
	}
	if err := s.SetAuth(context.Background(), "ws-j", AuthNone, ""); err != nil {
		t.Errorf("taking a credential away on jcode = %v", err)
	}
}

// A Codex session in a home of its own loads the MCP servers a Claude launch
// is given (the user's own and their project's), from its config.toml.
func TestACodexSessionLoadsTheComputersMCPServers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s, _, id := codexSession(t, CreateInput{WorkspaceID: "ws-mcp", Branch: "b", BaseBranch: "main"})
	s.runCommand = (&loginRecorder{}).run
	ctx := context.Background()
	mcp := map[string]json.RawMessage{
		"docs":    json.RawMessage(`{"type":"http","url":"https://mcp.example/docs","headers":{"Authorization":"Bearer tok-0123456789abcdef"}}`),
		"tracker": json.RawMessage(`{"type":"stdio","command":"npx","args":["-y","tracker-mcp"],"env":{"TRACKER_KEY":"key-0123456789abcdef"}}`),
	}
	if err := s.SetAgentConfig(ctx, AgentConfigRequest{MCPServers: mcp}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAuth(ctx, id, AuthOpenAIAPIKey, testOpenAIKey); err != nil {
		t.Fatalf("SetAuth: %v", err)
	}
	if _, err := s.Start(ctx, id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	config := readFileString(t, filepath.Join(s.codexHome(id), "config.toml"))
	for _, want := range []string{
		`[mcp_servers."docs"]`, `url = "https://mcp.example/docs"`, `http_headers = { "Authorization" = "Bearer tok-0123456789abcdef" }`,
		`[mcp_servers."tracker"]`, `command = "npx"`, `env = { "TRACKER_KEY" = "key-0123456789abcdef" }`,
	} {
		if !strings.Contains(config, want) {
			t.Errorf("config.toml lacks %q:\n%s", want, config)
		}
	}
	// TOML: the top-level keys still come before every table.
	if strings.Index(config, "cli_auth_credentials_store") > strings.Index(config, "[") {
		t.Errorf("a top-level key follows a table:\n%s", config)
	}

	// Gone from the computer, gone from the next launch's config.
	if err := s.SetAgentConfig(ctx, AgentConfigRequest{}); err != nil {
		t.Fatal(err)
	}
	if err := s.prepareCodexHome(ctx, id); err != nil {
		t.Fatal(err)
	}
	if config := readFileString(t, filepath.Join(s.codexHome(id), "config.toml")); strings.Contains(config, "mcp_servers") {
		t.Errorf("servers removed are still in config.toml:\n%s", config)
	}
}

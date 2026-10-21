package workspace

import (
	"context"
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

func TestACodexSessionSwitchesModelsButNeverToAGateway(t *testing.T) {
	t.Parallel()
	s, fake, id := codexSession(t, CreateInput{WorkspaceID: "ws-cx", Branch: "b", BaseBranch: "main", Model: "gpt-6-luna"})
	fake.running[sessionName(id)] = true
	ctx := context.Background()
	err := s.SetModel(ctx, id, ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-codex-0123456789abcdef"}, "")
	if !errors.Is(err, ErrGatewayUnsupported) {
		t.Fatalf("SetModel to a gateway = %v, want ErrGatewayUnsupported", err)
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

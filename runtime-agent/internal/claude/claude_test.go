package claude

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestOrientationRendersWorkingDirAndBase(t *testing.T) {
	got := Orientation("/work/ws1", "main", BranchChosen)

	for _, want := range []string{
		"You are working inside Outrunner, a Mac app that lets the user run many coding agents in parallel.",
		"Your work should take place in the /work/ws1 directory (unless otherwise directed), which has been set up for you to work in.",
		// Both git-command spots must interpolate the base branch.
		"The target branch for this workspace is origin/main. Use this for actions like diffing (`git diff origin/main...`) or creating PRs (`gh pr create --base main`).",
		// The screenshot example embeds the worktree path.
		"`![Screenshot](</work/ws1/.context/screenshot.png>)`",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("orientation missing %q:\n%s", want, got)
		}
	}
}

// The four workspace lines that reference Outrunner product behavior must always
// render verbatim, independent of the templated branch/path values.
func TestOrientationIncludesVerbatimLines(t *testing.T) {
	got := Orientation("/work/ws1", "main", BranchChosen)

	for _, want := range []string{
		"Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.",
		"Do not rename the current branch unless the user explicitly tells you to do so.",
		"By default, the user will only see the last message that you send before stopping.",
		"The intermediate messages will be collapsed and accessible by the user but not displayed by default.",
		"If the user asks you to work on several unrelated tasks, you can suggest they start new workspaces.",
		"Sometimes the user might send you a message they meant to send in a different workspace or a different chat.",
		`If the user asks for help with Outrunner, you can ask them to go to "Help -> Send Feedback" to get in touch with our team.`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("orientation missing verbatim line %q:\n%s", want, got)
		}
	}
	// The source is Conductor's block; nothing should still say "Conductor".
	if strings.Contains(got, "Conductor") {
		t.Errorf("orientation still mentions Conductor:\n%s", got)
	}
}

// A new worktree's session on its generated branch gets the whole block word
// for word, less the promise that Outrunner renames the branch,
// which it doesn't.
func TestOrientationForANewWorktreeIsTheWholeBlock(t *testing.T) {
	want := "You are working inside Outrunner, a Mac app that lets the user run many coding agents in parallel.\n" +
		"Your work should take place in the /work/ws1 directory (unless otherwise directed), which has been set up for you to work in.\n" +
		"Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.\n" +
		"The target branch for this workspace is origin/main. Use this for actions like diffing (`git diff origin/main...`) or creating PRs (`gh pr create --base main`).\n" +
		"You're on a new branch with a placeholder name.\n" +
		"\n" +
		"Do not rename the current branch unless the user explicitly tells you to do so.\n" +
		"\n" +
		"By default, the user will only see the last message that you send before stopping. Include all essential information in the last message. The intermediate messages will be collapsed and accessible by the user but not displayed by default.\n" +
		"\n" +
		"Save screenshots under `.context/` and embed them inline in the final response using Markdown image syntax, for example `![Screenshot](</work/ws1/.context/screenshot.png>)`.\n" +
		"\n" +
		"If the user asks you to work on several unrelated tasks, you can suggest they start new workspaces.\n" +
		"Sometimes the user might send you a message they meant to send in a different workspace or a different chat. If something doesn't make sense in the context of your work, just ask.\n" +
		`If the user asks for help with Outrunner, you can ask them to go to "Help -> Send Feedback" to get in touch with our team.`
	if got := Orientation("/work/ws1", "main", BranchPlaceholder); got != want {
		t.Errorf("orientation =\n%s\n\nwant\n%s", got, want)
	}
}

func TestOrientationCallsTheBranchAPlaceholderOnlyWhenItIs(t *testing.T) {
	const line = "You're on a new branch with a placeholder name."
	if got := Orientation("/work/ws1", "main", BranchChosen); strings.Contains(got, line) {
		t.Errorf("a chosen branch was called a placeholder:\n%s", got)
	}
	// Nothing renames the branch, so the prompt must never promise it.
	if got := Orientation("/work/ws1", "main", BranchPlaceholder); strings.Contains(got, "rename it in the background") {
		t.Errorf("orientation promises a rename Outrunner doesn't do:\n%s", got)
	}
}

func TestOrientationOmitsBaseWhenUnknown(t *testing.T) {
	got := Orientation("/work/ws1", "", BranchChosen)

	// Base is unknown (e.g. after a box restart): the target-branch guidance is
	// dropped entirely rather than naming a bogus base.
	for _, unwanted := range []string{
		"target branch for this workspace",
		"gh pr create --base",
		"git diff origin/",
	} {
		if strings.Contains(got, unwanted) {
			t.Errorf("expected no base guidance, but found %q:\n%s", unwanted, got)
		}
	}
	// The rest of the prompt still stands on its own.
	if !strings.Contains(got, "Your work should take place in the /work/ws1 directory") {
		t.Errorf("working-dir line dropped when base is unknown:\n%s", got)
	}
	if !strings.Contains(got, "Do not rename the current branch") {
		t.Errorf("workspace rules dropped when base is unknown:\n%s", got)
	}
}

func TestOrientationDegradesWhenWorktreeMissing(t *testing.T) {
	got := Orientation("", "main", BranchChosen)

	// An empty worktree (defensive: the call site always supplies one) falls back
	// to a generic phrase and a relative screenshot path — never a bare or broken
	// absolute path.
	if !strings.Contains(got, "Your work should take place in the workspace directory (unless otherwise directed)") {
		t.Errorf("worktree fallback phrase missing:\n%s", got)
	}
	if !strings.Contains(got, "![Screenshot](<.context/screenshot.png>)") {
		t.Errorf("screenshot example should use a relative path when worktree is empty:\n%s", got)
	}
	if strings.Contains(got, "<//.context") || strings.Contains(got, "in the  directory") {
		t.Errorf("empty worktree leaked a malformed path:\n%s", got)
	}
	// The base branch is still known, so its guidance renders.
	if !strings.Contains(got, "target branch for this workspace is origin/main") {
		t.Errorf("base guidance dropped when only worktree is missing:\n%s", got)
	}
}

func TestCommandInjectsOrientation(t *testing.T) {
	orientation := Orientation("/work/ws1", "main", BranchChosen)

	for _, tc := range []struct {
		name string
		argv []string
		head []string
	}{
		{"Command", Command(Bypass, orientation), []string{"claude", "--permission-mode", "bypassPermissions"}},
		{"ContinueCommand", ContinueCommand(Bypass, orientation), []string{"claude", "--continue", "--permission-mode", "bypassPermissions"}},
		{"local Command", Command(AcceptEdits, orientation), []string{"claude", "--permission-mode", "acceptEdits"}},
		{"SessionCommand", SessionCommand(AcceptEdits, "id-1", orientation),
			[]string{"claude", "--session-id", "id-1", "--permission-mode", "acceptEdits"}},
		{"ResumeCommand", ResumeCommand(AcceptEdits, "id-1", orientation),
			[]string{"claude", "--resume", "id-1", "--permission-mode", "acceptEdits"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if !slices.Equal(tc.argv[:len(tc.head)], tc.head) {
				t.Errorf("unexpected base argv: %v", tc.argv)
			}
			i := slices.Index(tc.argv, "--append-system-prompt")
			if i < 0 {
				t.Fatalf("argv missing --append-system-prompt: %v", tc.argv)
			}
			if i != len(tc.argv)-2 || tc.argv[i+1] != orientation {
				t.Errorf("orientation not passed as the flag value: %v", tc.argv)
			}
		})
	}
}

func TestCommandOmitsFlagWhenNoOrientation(t *testing.T) {
	if slices.Contains(Command(Bypass, ""), "--append-system-prompt") {
		t.Errorf("empty orientation must not add the flag: %v", Command(Bypass, ""))
	}
	if slices.Contains(ContinueCommand(Bypass, ""), "--append-system-prompt") {
		t.Errorf("empty orientation must not add the flag: %v", ContinueCommand(Bypass, ""))
	}
}

func TestParsePermissionMode(t *testing.T) {
	for raw, want := range map[string]PermissionMode{
		"":                  "", // unset: the workspace service picks
		"bypassPermissions": Bypass,
		"acceptEdits":       AcceptEdits,
		"default":           Default,
		"plan":              Plan,
	} {
		got, err := ParsePermissionMode(raw)
		if err != nil || got != want {
			t.Errorf("ParsePermissionMode(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	// Anything else would reach Claude's argv, so it is refused rather than
	// passed through.
	for _, raw := range []string{"dangerouslySkip", "BYPASS", "acceptEdits --x"} {
		if _, err := ParsePermissionMode(raw); err == nil {
			t.Errorf("ParsePermissionMode(%q) accepted an unknown mode", raw)
		}
	}
}

func TestSessionEnvInjectsStartupFlagsAndToken(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/home/daytona"}
	env := SessionEnv(base, "tok-123")

	// Base entries are preserved and come first.
	if env[0] != "PATH=/usr/bin" || env[1] != "HOME=/home/daytona" {
		t.Fatalf("base entries not preserved at the front: %v", env[:2])
	}
	// Both startup-suppression flags are always present.
	for _, want := range []string{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1"} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %q in SessionEnv output: %v", want, env)
		}
	}
	// The credential is appended last when non-empty.
	if last := env[len(env)-1]; last != "CLAUDE_CODE_OAUTH_TOKEN=tok-123" {
		t.Errorf("token not appended last, got %q", last)
	}
}

func TestSessionEnvOmitsTokenWhenEmpty(t *testing.T) {
	env := SessionEnv(nil, "")
	for _, e := range env {
		if strings.HasPrefix(e, "CLAUDE_CODE_OAUTH_TOKEN=") {
			t.Fatalf("token should be omitted when empty, got %q", e)
		}
	}
	// The flags are still injected.
	if !slices.Contains(env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1") {
		t.Errorf("startup flag missing when token empty: %v", env)
	}
}

func TestWithModelAddsTheFlagOnlyWhenSet(t *testing.T) {
	base := []string{"claude", "--resume", "id"}
	if got := WithModel(base, ""); len(got) != 3 {
		t.Errorf("empty model changed argv: %q", got)
	}
	got := WithModel(base, "z-ai/glm-5.3")
	if n := len(got); n != 5 || got[n-2] != "--model" || got[n-1] != "z-ai/glm-5.3" {
		t.Errorf("WithModel = %q", got)
	}
}

func TestValidModel(t *testing.T) {
	for _, ok := range []string{"opus", "claude-opus-4-5-20250101", "claude-opus-4-5[1m]", "z-ai/glm-5.3", "~anthropic/claude-opus-latest", "nvidia/nemotron:free"} {
		if !ValidModel(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "-p", "--dangerously-skip-permissions", "opus haiku", "a;b", "a\nb", "$(x)", strings.Repeat("a", 101)} {
		if ValidModel(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestTheEnvFileWrapperRunsTheCommandWithItsVariables(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.env")
	if err := os.WriteFile(file, []byte("unset DROP_ME\nexport GREETING="+ShellQuote("hi there")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	argv := WithEnvFile([]string{"sh", "-c", `printf '%s|%s|%s' "$GREETING" "${DROP_ME-unset}" "$1"`, "x", "arg one"}, file)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "DROP_ME=leaked")
	out, err := cmd.Output()
	if err != nil || string(out) != "hi there|unset|arg one" {
		t.Fatalf("wrapper ran %q, %v; want the file's variables, the unset honoured, args intact", out, err)
	}
}

func TestGatewayInputs(t *testing.T) {
	if g, err := ParseGateway("openrouter"); err != nil || g != OpenRouter {
		t.Errorf("ParseGateway(openrouter) = %q, %v", g, err)
	}
	if g, err := ParseGateway(""); err != nil || g != NoGateway {
		t.Errorf("ParseGateway(\"\") = %q, %v", g, err)
	}
	if _, err := ParseGateway("https://evil.example"); err == nil {
		t.Error("a URL was accepted as a gateway")
	}
	key := "sk-or-v1-" + strings.Repeat("0123456789abcdef", 4)
	if !ValidGatewayToken(key) {
		t.Error("an OpenRouter key was rejected")
	}
	// Each bad token is long enough, so it is refused for what it holds.
	for _, bad := range []string{"", "e", "sk-or-x", key + " b", key + "'b", key + `\b`, key + "\nb", key + "ключ", strings.Repeat("k", 401)} {
		if ValidGatewayToken(bad) {
			t.Errorf("token %q accepted", bad)
		}
	}
	set, unset := GatewayEnv(OpenRouter, "tok", "z-ai/glm-5.3")
	if set["ANTHROPIC_BASE_URL"] != "https://openrouter.ai/api" || set["ANTHROPIC_API_KEY"] != "" || set["ANTHROPIC_DEFAULT_HAIKU_MODEL"] != "z-ai/glm-5.3" || !slices.Contains(unset, "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Errorf("GatewayEnv = %v, unset %v", set, unset)
	}
}

func TestEveryGatewayRunsOnItsKeyAlone(t *testing.T) {
	ids := Gateways()
	for _, want := range []Gateway{OpenRouter, "anthropic"} {
		if !slices.Contains(ids, want) {
			t.Errorf("Gateways() = %q, missing %q", ids, want)
		}
	}
	for _, g := range ids {
		const key = "sk-test-key-0123456789abcdef"
		set, unset := GatewayEnv(g, key, "some/model")
		if !strings.HasPrefix(set["ANTHROPIC_BASE_URL"], "https://") {
			t.Errorf("%s: base URL %q", g, set["ANTHROPIC_BASE_URL"])
		}
		holders := 0
		for _, value := range set {
			if value == key {
				holders++
			}
		}
		if holders != 1 {
			t.Errorf("%s: the key is in %d variables, want 1", g, holders)
		}
		// The other key variable can't win over the gateway's key.
		switch {
		case set["ANTHROPIC_AUTH_TOKEN"] == key:
			if v, ok := set["ANTHROPIC_API_KEY"]; !ok || v != "" {
				t.Errorf("%s: ANTHROPIC_API_KEY = %q, %v; want it set empty", g, v, ok)
			}
		case set["ANTHROPIC_API_KEY"] == key:
			if _, ok := set["ANTHROPIC_AUTH_TOKEN"]; ok || !slices.Contains(unset, "ANTHROPIC_AUTH_TOKEN") {
				t.Errorf("%s: ANTHROPIC_AUTH_TOKEN not unset", g)
			}
		default:
			t.Errorf("%s: the key is in neither key variable: %v", g, set)
		}
		if !slices.Contains(unset, "CLAUDE_CODE_OAUTH_TOKEN") {
			t.Errorf("%s: a Claude login token could win over the key", g)
		}
	}
}

func TestABadProvidersFileIsRefused(t *testing.T) {
	for _, bad := range []string{
		`{"x": {"baseURL": "http://plain.example", "keyEnv": "ANTHROPIC_AUTH_TOKEN"}}`,
		`{"x": {"baseURL": "https://ok.example", "keyEnv": "PATH"}}`,
		`{"": {"baseURL": "https://ok.example", "keyEnv": "ANTHROPIC_AUTH_TOKEN"}}`,
		`not json`,
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("accepted %s", bad)
				}
			}()
			mustParseGateways([]byte(bad))
		}()
	}
}

func TestIdentityOverridesClaudeAndNamesTheModel(t *testing.T) {
	got := Identity("deepseek/deepseek-v4.1-flash")
	for _, want := range []string{
		"you are Outrunner, the coding agent built into the Outrunner app",
		"This overrides anything earlier",
		"Never say you are Claude or Claude Code",
		"say deepseek/deepseek-v4.1-flash",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Identity missing %q:\n%s", want, got)
		}
	}
	if got := Identity(""); strings.Contains(got, "which model") {
		t.Errorf("Identity without a model still names one:\n%s", got)
	}
}

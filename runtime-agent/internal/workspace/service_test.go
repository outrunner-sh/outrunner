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

	"runtime-agent/internal/claude"
	"runtime-agent/internal/codex"
)

func TestUnknownActivityStartsFreshWhenBoxLifetimeChanges(t *testing.T) {
	s := NewService(t.TempDir())
	s.lifetimeID = func() string { return "current-container" }
	old := unknownActivityMarker{
		Since:      time.Now().Add(-3 * time.Hour),
		LifetimeID: "previous-container",
	}
	data, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.unknownActivityPath(), data, 0o600); err != nil {
		t.Fatal(err)
	}

	last, active := s.unknownActivity("tmux list-sessions timed out")
	if !active || time.Since(last) > time.Minute {
		t.Errorf("unknown activity = (%s, %t), want a fresh active window", last, active)
	}
	data, err = os.ReadFile(s.unknownActivityPath())
	if err != nil {
		t.Fatal(err)
	}
	var current unknownActivityMarker
	if err := json.Unmarshal(data, &current); err != nil {
		t.Fatal(err)
	}
	if current.LifetimeID != "current-container" || current.Since.Before(last) {
		t.Errorf("persisted marker = %+v, want current container and fresh time", current)
	}
}

func TestBoxLifetimeIDPersistsWithEitherAvailableSource(t *testing.T) {
	if got := boxLifetimeIDParts("boot-id", "pid1-start"); got != "boot:boot-id:pid1:pid1-start" {
		t.Errorf("full lifetime ID = %q", got)
	}
	if got := boxLifetimeIDParts("boot-id", ""); got != "boot:boot-id" {
		t.Errorf("boot-only lifetime ID = %q", got)
	}
	if got := boxLifetimeIDParts("", "pid1-start"); got != "pid1:pid1-start" {
		t.Errorf("PID1-only lifetime ID = %q", got)
	}
	if got := boxLifetimeIDParts("", ""); got != "" {
		t.Errorf("lifetime ID without either source = %q, want empty", got)
	}
}

func TestOrientationUsesRecordedFacts(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws1", workspaceFacts{Branch: "feature/login", BaseBranch: "main"})

	got := s.orientation("ws1", "/work/ws1")
	if !strings.Contains(got, "in the /work/ws1 directory") {
		t.Errorf("orientation did not use the worktree path:\n%s", got)
	}
	if !strings.Contains(got, "target branch for this workspace is origin/main") {
		t.Errorf("orientation did not use the recorded base branch:\n%s", got)
	}
}

func TestOrientationOmitsBaseWhenFactsMissing(t *testing.T) {
	s := NewService(t.TempDir())

	// No facts recorded (simulates a box restart before the next Create): the
	// base branch is unknown, so the target-branch guidance is omitted. The
	// worktree path is always supplied by the call site, so it still renders.
	got := s.orientation("ws-missing", "/work/ws-missing")
	if !strings.Contains(got, "in the /work/ws-missing directory") {
		t.Errorf("orientation did not include the worktree path:\n%s", got)
	}
	if strings.Contains(got, "target branch for this workspace") {
		t.Errorf("base guidance should be omitted when facts are missing:\n%s", got)
	}
}

// A session on another company's model through a gateway answers as Outrunner;
// one on Claude, by the user's login or on Anthropic's API, stays Claude.
func TestOrientationSaysOutrunnerOnlyOffClaude(t *testing.T) {
	s := NewService(t.TempDir())
	for _, tc := range []struct {
		facts workspaceFacts
		want  bool
	}{
		{workspaceFacts{Model: "deepseek/deepseek-v4.1-flash", Gateway: claude.OpenRouter}, true},
		{workspaceFacts{Model: "glm-5.3", Gateway: "zai"}, true},
		{workspaceFacts{Model: "claude-opus-5", Gateway: claude.Anthropic}, false},
		{workspaceFacts{Model: "opus"}, false},
		{workspaceFacts{Model: "gpt-5.5", Agent: AgentCodex}, false},
	} {
		s.setFacts("ws", tc.facts)
		got := s.orientation("ws", "/work/ws")
		if has := strings.Contains(got, claude.Identity(tc.facts.Model)); has != tc.want {
			t.Errorf("%+v: identity in orientation = %v, want %v:\n%s", tc.facts, has, tc.want, got)
		}
		if !strings.Contains(got, "in the /work/ws directory") {
			t.Errorf("%+v: orientation lost its workspace lines:\n%s", tc.facts, got)
		}
	}
}

// Codex on Outrunner's model is told it is Outrunner, in Codex's terms: its
// own instructions call it Codex, not Claude.
func TestACodexOrientationOnAGatewaySaysOutrunnerOverCodex(t *testing.T) {
	s := NewService(t.TempDir())
	s.setFacts("ws", workspaceFacts{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Agent: AgentCodex})
	got := s.orientation("ws", "/work/ws")
	if !strings.Contains(got, codex.Identity()) || strings.Contains(got, claude.Identity("z-ai/glm-5.3")) {
		t.Errorf("orientation = %s\nwant Codex's identity, not Claude's", got)
	}
}

func TestCreateRecordsFacts(t *testing.T) {
	s := NewService(t.TempDir())
	// Create's git worktree step fails (no mirror), but facts are recorded first.
	_, _ = s.Create(context.Background(), CreateInput{
		WorkspaceID:    "ws2",
		Branch:         "feature/x",
		BaseBranch:     "develop",
		PermissionMode: claude.AcceptEdits,
	})

	f, ok := s.getFacts("ws2")
	if !ok {
		t.Fatal("Create did not record facts")
	}
	if f.Branch != "feature/x" || f.BaseBranch != "develop" || f.PermissionMode != claude.AcceptEdits {
		t.Errorf("facts = %+v, want {feature/x develop acceptEdits}", f)
	}
}

func TestFactsSurviveAgentRestart(t *testing.T) {
	root := t.TempDir()
	first := NewService(root)
	first.setFacts("ws3", workspaceFacts{Branch: "b", BaseBranch: "main", PermissionMode: claude.AcceptEdits, RepoPath: "/src/app"})

	// A local agent restarts with the desktop app while tmux keeps the session
	// alive, so a fresh Service on the same root must still know the mode.
	restarted := NewService(root)
	f, ok := restarted.getFacts("ws3")
	if !ok || f.PermissionMode != claude.AcceptEdits || f.RepoPath != "/src/app" {
		t.Fatalf("facts after restart = %+v, %v", f, ok)
	}
	if got := restarted.permissionMode("ws3"); got != claude.AcceptEdits {
		t.Errorf("permissionMode after restart = %q, want acceptEdits", got)
	}

	restarted.forgetWorkspace("ws3")
	if _, ok := NewService(root).getFacts("ws3"); ok {
		t.Error("forgetWorkspace left the facts file behind")
	}
}

func TestPermissionModeFallsBackToServiceDefault(t *testing.T) {
	s := NewService(t.TempDir())
	if got := s.permissionMode("unknown"); got != claude.Bypass {
		t.Errorf("Runtime Computer default = %q, want bypassPermissions", got)
	}
	// The desktop shell sets this, so a local session whose facts are missing
	// never falls back to bypass on the user's machine.
	s.DefaultPermissionMode = claude.AcceptEdits
	if got := s.permissionMode("unknown"); got != claude.AcceptEdits {
		t.Errorf("desktop default = %q, want acceptEdits", got)
	}
}

func TestSessionsInAFolderNeverBypassPermissions(t *testing.T) {
	isolateGit(t)
	folder := t.TempDir()
	s := NewService(t.TempDir())
	// Asked for outright, it is refused before anything is created.
	if _, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-bypass", Branch: "runtime/x", RepoPath: folder, PermissionMode: claude.Bypass,
	}); !errors.Is(err, ErrBypassInFolder) {
		t.Fatalf("Create with bypassPermissions = %v, want ErrBypassInFolder", err)
	}
	if _, ok := s.getFacts("ws-bypass"); ok {
		t.Error("a refused create recorded facts")
	}
	// Not asked for, and with no agent default either, it is acceptEdits.
	if _, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-unset", Branch: "runtime/y", RepoPath: folder,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := s.permissionMode("ws-unset"); got != claude.AcceptEdits {
		t.Errorf("unset mode in a folder = %q, want acceptEdits", got)
	}
}

func TestCreateRejectsOptionLikeBranches(t *testing.T) {
	s := NewService(t.TempDir())
	for _, in := range []CreateInput{
		{WorkspaceID: "ws4", Branch: "--upload-pack=x", BaseBranch: "main"},
		{WorkspaceID: "ws4", Branch: "ok", BaseBranch: "-c"},
	} {
		if _, err := s.Create(context.Background(), in); err == nil {
			t.Errorf("Create(%+v) accepted an option-like branch", in)
		}
	}
}

func TestIsTrustDialog(t *testing.T) {
	// Captured from Claude Code opening a fresh folder in tmux (2026-10).
	pane := ` Accessing workspace:
 /private/tmp/outrunner-probe.obXI
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 ❯ 1. Yes, I trust this folder
   2. No, exit`
	if !isTrustDialog(pane) {
		t.Error("current trust dialog not recognised")
	}
	if !isTrustDialog("Do you trust the files in this folder?") {
		t.Error("earlier trust dialog wording not recognised")
	}
	if isTrustDialog("╭───╮\n│ ❯ │\n╰───╯") {
		t.Error("the composer was mistaken for the trust dialog")
	}
}

func TestSessionEnvironmentExcludesAgentControlSecrets(t *testing.T) {
	env, secrets := sessionEnvironment([]string{
		"PATH=/usr/bin",
		"RUNTIME_AGENT_SECRET=control-secret",
		"RUNTIME_AGENT_ROOT=/home/runtime",
		"PORT=8080",
		"CLAUDE_CODE_OAUTH_TOKEN=claude-secret",
	})
	got := strings.Join(env, "\n")
	if strings.Contains(got, "RUNTIME_AGENT_SECRET") || strings.Contains(got, "RUNTIME_AGENT_ROOT") || strings.Contains(got, "PORT=8080") {
		t.Fatalf("agent control variables leaked to session environment: %q", got)
	}
	if !strings.Contains(got, "CLAUDE_CODE_OAUTH_TOKEN=claude-secret") || len(secrets) != 1 || secrets[0] != "claude-secret" {
		t.Fatalf("Claude credential was not retained safely: env=%q secrets=%q", got, secrets)
	}
}

// The user's GitHub token reaches the session for gh, is masked in the
// terminal, and answers git's credential prompt for github.com and nowhere
// else: run through real git, as the agent's `git push` would.
func TestSessionEnvironmentGivesGitTheGitHubTokenForGitHubOnly(t *testing.T) {
	env, secrets := sessionEnvironment([]string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + t.TempDir(),
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=credential.helper",
		"GIT_CONFIG_VALUE_0=!echo password=the-box-own",
		"GH_TOKEN=gho_user",
	})
	if !slices.Contains(env, "GH_TOKEN=gho_user") || !slices.Contains(secrets, "gho_user") {
		t.Fatalf("GitHub token not kept and masked: env=%q secrets=%q", env, secrets)
	}

	fill := func(host string) string {
		cmd := exec.Command("git", "credential", "fill")
		cmd.Env = append(env, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1")
		cmd.Stdin = strings.NewReader("protocol=https\nhost=" + host + "\n\n")
		out, _ := cmd.Output()
		return string(out)
	}
	if got := fill("github.com"); !strings.Contains(got, "password=gho_user") {
		t.Fatalf("git did not get the token for github.com: %q", got)
	}
	if got := fill("example.com"); strings.Contains(got, "gho_user") {
		t.Fatalf("git handed the token to another host: %q", got)
	}
}

func TestSessionEnvironmentWithoutGitHubTokenLeavesGitAlone(t *testing.T) {
	env, _ := sessionEnvironment([]string{"PATH=/usr/bin", "GH_TOKEN="})
	for _, entry := range env {
		if strings.HasPrefix(entry, "GIT_CONFIG_") {
			t.Fatalf("git configured without a token: %q", env)
		}
	}
}

func TestValidSessionIDRejectsPathEscapes(t *testing.T) {
	good := []string{"sess-123", "a1b2c3d4", "0e3f-9c2a"}
	for _, id := range good {
		if !validSessionID(id) {
			t.Errorf("valid session id %q rejected", id)
		}
	}
	bad := []string{"", ".", "..", "../x", "a/b", "a\\b", "x/../y", "..\\y"}
	for _, id := range bad {
		if validSessionID(id) {
			t.Errorf("path-escaping session id %q accepted", id)
		}
	}
}

func TestClaudeConvDirEncodesWorktreePath(t *testing.T) {
	t.Setenv("HOME", "/home/daytona")
	s := NewService("/home/daytona")
	// Claude derives the conversation dir under $HOME from the session cwd (the
	// worktree) via transcript.ClaudeSlug (non-alphanumerics -> '-'). This must match what Claude
	// writes on disk, since SendMessage polls it to confirm a prompt landed.
	got := s.claudeConvDir("abc123")
	want := "/home/daytona/.claude/projects/-home-daytona-workspaces-abc123"
	if got != want {
		t.Errorf("claudeConvDir = %q, want %q", got, want)
	}
}

func TestUserTurnCountMissingDirIsZero(t *testing.T) {
	if got := userTurnCount(t.TempDir()+"/does-not-exist", nil); got != 0 {
		t.Errorf("userTurnCount(missing) = %d, want 0", got)
	}
}

func TestAPromptQueuedMidTurnCountsAsLanded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	turn := `{"type":"user","message":{"role":"user","content":"fix it"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"on it, \"type\":\"user\""}]}}
`
	write(turn)
	before := fileUserTurns(path)
	if before != 1 {
		t.Fatalf("one prompt counted as %d", before)
	}
	// Sent while Claude runs a tool: queued, not yet a user message.
	write(turn + `{"type":"queue-operation","operation":"enqueue","content":"whats next?"}` + "\n")
	if got := fileUserTurns(path); got <= before {
		t.Errorf("a queued prompt didn't count: %d, was %d", got, before)
	}
	// Taken off the queue without being a prompt of its own (absorbed mid-turn): no more than queued.
	write(turn + `{"type":"queue-operation","operation":"enqueue","content":"x"}` + "\n" + `{"type":"queue-operation","operation":"remove"}` + "\n")
	if got := fileUserTurns(path); got != before+1 {
		t.Errorf("enqueue then remove = %d, want %d", got, before+1)
	}
}

func TestOnlyTheSameTextSoonAfterRetriesAStagedPrompt(t *testing.T) {
	now := time.Now()
	stage := func() *sendState {
		return &sendState{staged: &stagedPrompt{content: "fix it", baseline: 3, at: now}}
	}
	if baseline, retry := stage().takeStaged("fix it", now.Add(time.Minute)); !retry || baseline != 3 {
		t.Errorf("same text = %d, %v; want a retry from 3", baseline, retry)
	}
	if _, retry := stage().takeStaged("something else", now); retry {
		t.Error("different text was taken for a retry")
	}
	if _, retry := stage().takeStaged("fix it", now.Add(stagedRetryWindow+time.Second)); retry {
		t.Error("the same text long after was taken for a retry")
	}
	st := stage()
	st.takeStaged("something else", now)
	if st.staged != nil {
		t.Error("takeStaged kept the staged prompt")
	}
}

func TestRetryingAPromptThatLandedLateDoesNotSendItAgain(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := NewService(t.TempDir())
	// The first send gave up with the text staged and no user turn recorded;
	// Claude has recorded it since.
	s.sendLock("ws-late").staged = &stagedPrompt{content: "fix it", baseline: 0, at: time.Now()}
	dir := s.claudeConvDir("ws-late")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "c.jsonl"), []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// There is no tmux session: any paste or Enter would fail the send.
	if err := s.SendMessage("ws-late", "fix it"); err != nil {
		t.Fatalf("retry of a landed prompt = %v, want success without sending", err)
	}
}

func TestASessionsModelIsRecordedAndLaunchedWith(t *testing.T) {
	root := t.TempDir()
	s := NewService(root)
	s.tmux = newFakeSessions() // no session running
	_, _ = s.Create(context.Background(), CreateInput{WorkspaceID: "ws-m", Branch: "b", BaseBranch: "main", Model: "sonnet"})
	if got := s.launchCommand("ws-m", s.worktreePath("ws-m"), false); !slices.Contains(got, "--model") || got[len(got)-1] != "sonnet" {
		t.Fatalf("launch = %q, want --model sonnet", got)
	}
	if got := s.launchCommand("ws-m", s.worktreePath("ws-m"), true); got[len(got)-1] != "sonnet" || !slices.Contains(got, "--continue") {
		t.Fatalf("resume = %q, want --continue … --model sonnet", got)
	}

	// No session is running, so the switch is only recorded: the next launch
	// uses it, and so does an agent that restarts.
	if err := s.SetModel(context.Background(), "ws-m", ModelChoice{Model: "z-ai/glm-5.3"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	restarted := NewService(root)
	if got := restarted.launchCommand("ws-m", restarted.worktreePath("ws-m"), true); got[len(got)-1] != "z-ai/glm-5.3" {
		t.Fatalf("after restart launch = %q, want the switched model", got)
	}

	// A re-Create that names no model (the control plane after a box restart)
	// keeps the switch.
	_, _ = restarted.Create(context.Background(), CreateInput{WorkspaceID: "ws-m", Branch: "b", BaseBranch: "main"})
	if f, _ := restarted.getFacts("ws-m"); f.Model != "z-ai/glm-5.3" {
		t.Errorf("re-Create dropped the model: %+v", f)
	}
}

func TestNoModelLaunchesClaudesDefault(t *testing.T) {
	s := NewService(t.TempDir())
	_, _ = s.Create(context.Background(), CreateInput{WorkspaceID: "ws-d", Branch: "b", BaseBranch: "main"})
	if got := s.launchCommand("ws-d", s.worktreePath("ws-d"), false); slices.Contains(got, "--model") {
		t.Errorf("launch = %q, want no --model", got)
	}
}

func TestSetModelOnAnUnknownWorkspaceWritesNothing(t *testing.T) {
	root := t.TempDir()
	s := NewService(root)
	if err := s.SetModel(context.Background(), "ws-none", ModelChoice{Model: "opus"}, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Fatalf("SetModel = %v, want ErrUnknownWorkspace", err)
	}
	if _, err := os.Stat(s.factsPath("ws-none")); !os.IsNotExist(err) {
		t.Errorf("a facts file was written for a workspace never created: %v", err)
	}
}

func TestASessionOnAGatewayGetsItsKeyFromAPrivateFile(t *testing.T) {
	root := t.TempDir()
	s := NewService(root)
	s.tmux = newFakeSessions() // no session running
	ctx := context.Background()
	_, _ = s.Create(ctx, CreateInput{WorkspaceID: "ws-g", Branch: "b", BaseBranch: "main", Model: "sonnet"})
	const key = "sk-or-v1-session-key-0123456789abcdef"
	if err := s.SetModel(ctx, "ws-g", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: key}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}

	info, err := os.Stat(s.gatewayEnvPath("ws-g"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("gateway file = %v, %v; want it owner-only", info, err)
	}
	env := s.readGatewayEnv("ws-g")
	for _, want := range []string{
		"export ANTHROPIC_BASE_URL='https://openrouter.ai/api'",
		"export ANTHROPIC_AUTH_TOKEN='" + key + "'",
		"export ANTHROPIC_API_KEY=''",
		"export ANTHROPIC_MODEL='z-ai/glm-5.3'",
		"export ANTHROPIC_CUSTOM_MODEL_OPTION='z-ai/glm-5.3'",
		"unset CLAUDE_CODE_OAUTH_TOKEN",
	} {
		if !strings.Contains(env, want) {
			t.Errorf("gateway file lacks %q:\n%s", want, env)
		}
	}

	argv := s.launchCommand("ws-g", s.worktreePath("ws-g"), true)
	if argv[0] != "sh" || !slices.Contains(argv, s.gatewayEnvPath("ws-g")) || !slices.Contains(argv, "claude") {
		t.Fatalf("launch = %q, want claude run after sourcing the gateway file", argv)
	}
	if slices.Contains(argv, "--model") || strings.Contains(strings.Join(argv, " "), key) {
		t.Errorf("launch = %q, want no --model and never the key", argv)
	}
	if !slices.Contains(s.RedactionSecrets(), key) {
		t.Error("the gateway key is not redacted from terminal output")
	}
	// A restarted agent still masks the key of a session tmux kept running.
	if !slices.Contains(NewService(root).RedactionSecrets(), key) {
		t.Error("after a restart the gateway key is not redacted")
	}

	// Back to the user's own Claude: the file goes, and --model returns.
	if err := s.SetModel(ctx, "ws-g", ModelChoice{Model: "opus"}, ""); err != nil {
		t.Fatalf("SetModel back: %v", err)
	}
	if _, err := os.Stat(s.gatewayEnvPath("ws-g")); !os.IsNotExist(err) {
		t.Errorf("gateway file kept after switching back: %v", err)
	}
	if got := s.launchCommand("ws-g", s.worktreePath("ws-g"), true); got[0] != "claude" || got[len(got)-1] != "opus" {
		t.Errorf("launch after switching back = %q", got)
	}
	// The conversation it continues can still redraw the key: it stays masked
	// until the session is forgotten.
	if !slices.Contains(s.RedactionSecrets(), key) {
		t.Error("the key of a session switched back to Claude is no longer masked")
	}
	s.forgetWorkspace("ws-g")
	if slices.Contains(s.RedactionSecrets(), key) {
		t.Error("a forgotten session's key is still listed")
	}
}

func TestForgettingASessionRemovesItsGatewayKey(t *testing.T) {
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	ctx := context.Background()
	_, _ = s.Create(ctx, CreateInput{WorkspaceID: "ws-f", Branch: "b", BaseBranch: "main"})
	if err := s.SetModel(ctx, "ws-f", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-forget-0123456789abcdef"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if _, err := os.Stat(s.gatewayEnvPath("ws-f")); err != nil {
		t.Fatalf("no gateway file to forget: %v", err)
	}
	s.forgetWorkspace("ws-f")
	if _, err := os.Stat(s.gatewayEnvPath("ws-f")); !os.IsNotExist(err) {
		t.Errorf("gateway file outlived its session: %v", err)
	}
}

func TestClaudeIsBusyOnlyMidTurn(t *testing.T) {
	// Captured from Claude Code 2.1 in tmux (2026-10): idle, then mid-turn.
	idle := "❯ Try \"edit <filepath> to...\"\n  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"
	working := "✶ Combobulating…\n  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ← for agents"
	if claudeIsBusy(idle) {
		t.Error("an idle Claude read as busy")
	}
	if !claudeIsBusy(working) {
		t.Error("a Claude mid-turn read as idle")
	}
}

func TestTheJcodeEngineRefusesAModelSwitch(t *testing.T) {
	s := NewService(t.TempDir())
	s.jcode = &jcodeEngine{}
	if err := s.SetModel(context.Background(), "ws-j", ModelChoice{Model: "opus"}, ""); !errors.Is(err, ErrModelUnsupported) {
		t.Fatalf("SetModel on jcode = %v, want ErrModelUnsupported", err)
	}
	if _, ok := s.getFacts("ws-j"); ok {
		t.Error("a refused switch was recorded")
	}
}

func TestARepeatedCreateKeepsTheGateway(t *testing.T) {
	root := t.TempDir()
	s := NewService(root)
	s.tmux = newFakeSessions() // no session running
	ctx := context.Background()
	_, _ = s.Create(ctx, CreateInput{WorkspaceID: "ws-r", Branch: "b", BaseBranch: "main"})
	if err := s.SetModel(ctx, "ws-r", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-recreate-0123456789abcdef"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}

	// The control plane re-creates after an agent restart, naming no model.
	restarted := NewService(root)
	_, _ = restarted.Create(ctx, CreateInput{WorkspaceID: "ws-r", Branch: "b", BaseBranch: "main"})
	if f, _ := restarted.getFacts("ws-r"); f.Gateway != claude.OpenRouter || f.Model != "z-ai/glm-5.3" {
		t.Fatalf("re-Create facts = %+v, want the gateway and its model kept", f)
	}
	if argv := restarted.launchCommand("ws-r", restarted.worktreePath("ws-r"), true); argv[0] != "sh" {
		t.Errorf("launch after re-Create = %q, want it through the gateway file", argv)
	}

	// Even naming another model, a re-Create leaves the switch to SetModel:
	// the key stays, still masked, for the session that may be running on it.
	_, _ = restarted.Create(ctx, CreateInput{WorkspaceID: "ws-r", Branch: "b", BaseBranch: "main", Model: "sonnet"})
	if f, _ := restarted.getFacts("ws-r"); f.Gateway != claude.OpenRouter || f.Model != "z-ai/glm-5.3" {
		t.Errorf("re-Create with another model = %+v, want the gateway session unchanged", f)
	}
	if !slices.Contains(restarted.RedactionSecrets(), "sk-or-v1-recreate-0123456789abcdef") {
		t.Error("a re-Create unmasked the key of the session running on it")
	}
}

func TestARepeatedCreateLeavesAClaudeSessionsModel(t *testing.T) {
	root := t.TempDir()
	s := NewService(root)
	ctx := context.Background()
	_, _ = s.Create(ctx, CreateInput{WorkspaceID: "ws-c", Branch: "b", BaseBranch: "main", Model: "opus"})
	_, _ = NewService(root).Create(ctx, CreateInput{WorkspaceID: "ws-c", Branch: "b", BaseBranch: "main", Model: "sonnet"})
	if f, _ := NewService(root).getFacts("ws-c"); f.Model != "opus" {
		t.Errorf("re-Create switched the model to %q; only SetModel, which relaunches, may", f.Model)
	}
}

func TestASwitchWaitsForAPromptBeingSent(t *testing.T) {
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	ctx := context.Background()
	_, _ = s.Create(ctx, CreateInput{WorkspaceID: "ws-l", Branch: "b", BaseBranch: "main"})
	// A send in flight holds the send lock; the switch's busy check must come
	// after it, or the prompt could land between the check and the kill.
	lock := s.sendLock("ws-l")
	lock.Lock()
	done := make(chan error, 1)
	go func() { done <- s.SetModel(ctx, "ws-l", ModelChoice{Model: "opus"}, "") }()
	select {
	case err := <-done:
		lock.Unlock()
		t.Fatalf("SetModel returned (%v) while a prompt was being sent", err)
	case <-time.After(150 * time.Millisecond):
	}
	lock.Unlock()
	if err := <-done; err != nil {
		t.Fatalf("SetModel after the send = %v", err)
	}
}

func TestASwitchCancelledWhileWaitingRecordsNothing(t *testing.T) {
	s := NewService(t.TempDir())
	_, _ = s.Create(context.Background(), CreateInput{WorkspaceID: "ws-x", Branch: "b", BaseBranch: "main", Model: "sonnet"})
	lock := s.sendLock("ws-x")
	lock.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.SetModel(ctx, "ws-x", ModelChoice{Model: "opus"}, "") }()
	time.Sleep(50 * time.Millisecond)
	cancel() // the client gives up while a prompt is still being sent
	lock.Unlock()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("SetModel = %v, want context.Canceled", err)
	}
	if f, _ := s.getFacts("ws-x"); f.Model != "sonnet" {
		t.Errorf("a cancelled switch recorded %q", f.Model)
	}
}

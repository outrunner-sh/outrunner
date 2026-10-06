package workspace

import (
	"context"
	"strings"
	"testing"

	"runtime-agent/internal/claude"
)

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
	// worktree) via claudeSlug ('/' and '.' -> '-'). This must match what Claude
	// writes on disk, since SendMessage polls it to confirm a prompt landed.
	got := s.claudeConvDir("abc123")
	want := "/home/daytona/.claude/projects/-home-daytona-workspaces-abc123"
	if got != want {
		t.Errorf("claudeConvDir = %q, want %q", got, want)
	}
}

func TestUserTurnCountMissingDirIsZero(t *testing.T) {
	if got := userTurnCount(t.TempDir() + "/does-not-exist"); got != 0 {
		t.Errorf("userTurnCount(missing) = %d, want 0", got)
	}
}

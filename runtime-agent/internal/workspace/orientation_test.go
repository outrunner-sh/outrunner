package workspace

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Only a worktree still on the branch Outrunner named for it is told its branch
// is a placeholder: not the user's own branch, one renamed since, a detached
// HEAD, or a folder that isn't a repository.
func TestOnlyAWorktreeStillOnItsGeneratedBranchIsAPlaceholder(t *testing.T) {
	isolateGit(t)
	dir := newCheckout(t)
	if onPlaceholderBranch(dir) {
		t.Error("main was called a placeholder")
	}
	run(t, dir, "switch", "-q", "-c", "runtime/mv69bt00-3a01334a")
	if !onPlaceholderBranch(dir) {
		t.Error("the generated branch wasn't recognised")
	}
	run(t, dir, "branch", "-q", "-m", "fix-login-page")
	if onPlaceholderBranch(dir) {
		t.Error("a branch renamed since was still called a placeholder")
	}
	run(t, dir, "switch", "-q", "-c", "runtime/mv69bt00-3a01334b")
	run(t, dir, "switch", "-q", "--detach")
	if onPlaceholderBranch(dir) {
		t.Error("a detached HEAD was called a placeholder")
	}
	if onPlaceholderBranch(t.TempDir()) || onPlaceholderBranch("") {
		t.Error("a folder that isn't a repository was called a placeholder")
	}
}

// Through Start: a Runtime Computer's session on its generated branch launches
// Claude told the branch is a placeholder; a session in the user's own folder
// isn't.
func TestANewWorktreeSessionIsToldItsBranchIsAPlaceholder(t *testing.T) {
	isolateGit(t)
	const line = "You're on a new branch with a placeholder name."

	s := NewService(t.TempDir())
	fake := newFakeSessions()
	fake.pane = composerPane
	s.tmux = fake
	const id = "ws-cloud"
	// A worktree of the mirror on its generated branch (made here, so Create
	// takes it as made).
	worktree := s.worktreePath(id)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, worktree, "init", "-q", "-b", "runtime/mv69bt00-3a01334a")
	run(t, worktree, "commit", "-q", "--allow-empty", "-m", "base")
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: id, Branch: "runtime/mv69bt00-3a01334a", BaseBranch: "main"}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { s.stopRecorder(context.Background(), id) })
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if prompt := strings.Join(fake.lastLaunch(), " "); !strings.Contains(prompt, line) {
		t.Errorf("a new worktree's session wasn't told its branch is a placeholder:\n%s", prompt)
	}

	local, localFake, localID, _ := stoppedSession(t)
	localFake.pane = composerPane
	if _, err := local.Start(context.Background(), localID, ""); err != nil {
		t.Fatalf("Start (in place): %v", err)
	}
	if prompt := strings.Join(localFake.lastLaunch(), " "); strings.Contains(prompt, line) {
		t.Errorf("a session in the user's folder was told it's on a new branch:\n%s", prompt)
	}
}

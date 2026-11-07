package workspace

import (
	"context"
	"os"
	"path/filepath"
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
	run(t, dir, "branch", "-q", "-m", "outrunner/fix-login-redirect-3fa9c1")
	if !onPlaceholderBranch(dir) {
		t.Error("the generated branch, named from the prompt, wasn't recognised")
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

// startOnMac creates and starts a This Mac session on a git checkout, which
// gets a worktree of its own on branch, as the desktop app's sessions do.
func startOnMac(t *testing.T, repo, branch string) (*Service, *fakeSessions, string) {
	t.Helper()
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	fake.pane = composerPane
	s.tmux = fake
	const id = "ws-mac"
	worktree, err := s.Create(context.Background(), CreateInput{WorkspaceID: id, Branch: branch, RepoPath: repo})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { s.stopRecorder(context.Background(), id) })
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return s, fake, worktree
}

// The usual This Mac session, on a git repository, works in a worktree on its
// generated branch, and is told so like a Runtime Computer's.
func TestAThisMacSessionOnAGitRepoIsToldItsBranchIsAPlaceholder(t *testing.T) {
	isolateGit(t)
	_, fake, _ := startOnMac(t, newCheckout(t), "runtime/mv69bt00-3a01334a")
	if prompt := strings.Join(fake.lastLaunch(), " "); !strings.Contains(prompt, "You're on a new branch with a placeholder name.") {
		t.Errorf("a This Mac session wasn't told its branch is a placeholder:\n%s", prompt)
	}
}

// The orientation promises a gitignored .context directory: a session's
// worktree has one, and what Claude saves there stays out of git, while the
// user's own checkout is untouched.
func TestASessionsContextDirIsThereAndIgnored(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	_, _, worktree := startOnMac(t, repo, "runtime/mv69bt00-3a01334a")
	if err := os.WriteFile(filepath.Join(worktree, ".context", "screenshot.png"), []byte("png"), 0o644); err != nil {
		t.Fatalf("saving under .context: %v", err)
	}
	if status := run(t, worktree, "status", "--porcelain", "--untracked-files=all"); status != "" {
		t.Errorf(".context shows in git:\n%s", status)
	}
	if status := run(t, repo, "status", "--porcelain", "--untracked-files=all"); status != "" {
		t.Errorf("the user's checkout changed:\n%s", status)
	}
}

// A repository that tracks a .context of its own keeps it as it is: a "*" there
// would hide new files the project means to commit.
func TestARepositorysOwnContextDirIsLeftAlone(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	if err := os.MkdirAll(filepath.Join(repo, ".context"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".context", "notes.md"), []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-q", "-m", "context notes")
	_, _, worktree := startOnMac(t, repo, "runtime/mv69bt00-3a01334a")
	if _, err := os.Stat(filepath.Join(worktree, ".context", ".gitignore")); !os.IsNotExist(err) {
		t.Errorf("a .gitignore was added to the repository's own .context (stat: %v)", err)
	}
}

// A session in the user's own folder (not a repository) isn't given one: the
// folder isn't Outrunner's to add to.
func TestASessionInTheUsersFolderGetsNoContextDir(t *testing.T) {
	isolateGit(t)
	s, fake, id, folder := stoppedSession(t)
	fake.pane = composerPane
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := os.Stat(filepath.Join(folder, ".context")); !os.IsNotExist(err) {
		t.Errorf("a .context was made in the user's folder (stat: %v)", err)
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

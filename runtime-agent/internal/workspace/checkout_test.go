package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// These run real git against throwaway repositories, because what matters is
// what git actually does to someone's checkout.

// isolateGit keeps the developer's own git config (signing, hooks, URL
// rewrites) out of the test. It must run before NewService, which snapshots
// the environment.
func isolateGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir,
		"-c", "user.name=Test", "-c", "user.email=test@example.com"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newCheckout makes a "user's clone": a repo on main with one commit.
func newCheckout(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "init", "--quiet", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "add", ".")
	run(t, dir, "commit", "--quiet", "-m", "first")
	return dir
}

func TestCreateFromCheckoutLeavesTheCheckoutAlone(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())

	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-local", Branch: "runtime/abc", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if worktree != s.worktreePath("ws-local") {
		t.Errorf("worktree = %q, want %q", worktree, s.worktreePath("ws-local"))
	}
	if got := run(t, worktree, "rev-parse", "--abbrev-ref", "HEAD"); got != "runtime/abc" {
		t.Errorf("worktree branch = %q, want runtime/abc", got)
	}
	if _, err := os.Stat(filepath.Join(worktree, "README.md")); err != nil {
		t.Errorf("worktree is missing the base commit's files: %v", err)
	}
	// The user's own checkout stays on its branch, untouched.
	if got := run(t, repo, "rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Errorf("checkout moved to %q", got)
	}
	if got := run(t, repo, "status", "--porcelain"); got != "" {
		t.Errorf("checkout is dirty after Create: %q", got)
	}
	if !s.local("ws-local") {
		t.Error("workspace not recorded as local")
	}
}

func TestCreateFromCheckoutForksFromTheRemoteBase(t *testing.T) {
	isolateGit(t)
	// origin has moved on since the user last pulled: the session must start
	// from origin/main, not the stale local main.
	upstream := newCheckout(t)
	repo := filepath.Join(t.TempDir(), "clone")
	run(t, upstream, "clone", "--quiet", upstream, repo)
	if err := os.WriteFile(filepath.Join(upstream, "NEW.md"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, upstream, "add", ".")
	run(t, upstream, "commit", "--quiet", "-m", "second")
	want := run(t, upstream, "rev-parse", "HEAD")

	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-fresh", Branch: "runtime/fresh", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := run(t, worktree, "rev-parse", "HEAD"); got != want {
		t.Errorf("worktree forked from %s, want origin/main %s", got, want)
	}
}

func TestCreateFromCheckoutRejectsANonRepository(t *testing.T) {
	isolateGit(t)
	s := NewService(t.TempDir())
	for _, path := range []string{t.TempDir(), "relative/path"} {
		_, err := s.Create(context.Background(), CreateInput{
			WorkspaceID: "ws-bad", Branch: "runtime/x", BaseBranch: "main", RepoPath: path,
		})
		if err == nil {
			t.Errorf("Create accepted %q as a repository", path)
		}
	}
}

func TestDestroyRemovesTheWorktreeButKeepsTheBranch(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-gone", Branch: "runtime/gone", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Work committed in the session that was never pushed.
	if err := os.WriteFile(filepath.Join(worktree, "work.txt"), []byte("w\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, worktree, "add", ".")
	run(t, worktree, "commit", "--quiet", "-m", "work")

	// A fresh Service, as after an agent restart: Destroy has to find the
	// owning repository from the worktree itself.
	if err := NewService(s.Root).Destroy(context.Background(), "ws-gone"); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Errorf("worktree still on disk: %v", err)
	}
	if list := run(t, repo, "worktree", "list"); strings.Contains(list, worktree) {
		t.Errorf("checkout still lists the worktree:\n%s", list)
	}
	if got := run(t, repo, "log", "-1", "--format=%s", "runtime/gone"); got != "work" {
		t.Errorf("session branch lost its commit, got %q", got)
	}
}

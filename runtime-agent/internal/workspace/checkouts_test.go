package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/protocol"
)

// repoMirror makes a mirror at path whose origin has one commit on branch,
// holding README and a .gitignore of node_modules.
func repoMirror(t *testing.T, path, branch string) {
	t.Helper()
	src := t.TempDir()
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run(src, "init", "-q", "-b", branch)
	_ = os.WriteFile(filepath.Join(src, "README"), []byte("hi\n"), 0o644)
	_ = os.WriteFile(filepath.Join(src, ".gitignore"), []byte("node_modules/\n"), 0o644)
	run(src, "add", ".")
	run(src, "commit", "-q", "-m", "init")
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	run(filepath.Dir(path), "clone", "-q", "--bare", src, path)
	run(path, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	run(path, "fetch", "-q", "origin")
}

// A session of two repositories works in a folder of their checkouts, each on
// the session's branch off its own base; its changes are each one's, under
// its folder; it goes with both.
func TestASessionOfSeveralRepositories(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	repoMirror(t, RepoMirrorPath(s.Root, "web"), "main")
	repoMirror(t, RepoMirrorPath(s.Root, "api"), "develop")
	ctx := context.Background()

	folder, err := s.Create(ctx, CreateInput{
		WorkspaceID: "ws1",
		Branch:      "runtime/x",
		GitUser:     &GitUser{Name: "Ada", Email: "ada@example.com"},
		Checkouts: []Checkout{
			{Name: "web", FullName: "acme/web", BaseBranch: "main"},
			{Name: "api", FullName: "acme/api", BaseBranch: "develop"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"web", "api"} {
		dir := filepath.Join(folder, name)
		if branch, _ := s.git(ctx, dir, "symbolic-ref", "--short", "HEAD"); branch != "runtime/x" {
			t.Errorf("%s branch = %q", name, branch)
		}
		if email, _ := s.git(ctx, dir, "config", "user.email"); email != "ada@example.com" {
			t.Errorf("%s user = %q", name, email)
		}
	}
	if fileExists(filepath.Join(folder, ".git")) {
		t.Error("the session's folder is itself a repository")
	}
	o := s.orientation("ws1", folder)
	for _, want := range []string{"`web/`: acme/web, targeting origin/main", "`api/`: acme/api, targeting origin/develop"} {
		if !strings.Contains(o, want) {
			t.Errorf("orientation lacks %q", want)
		}
	}

	_ = os.WriteFile(filepath.Join(folder, "web", "README"), []byte("hi\nthere\n"), 0o644)
	_ = os.WriteFile(filepath.Join(folder, "api", "new.go"), []byte("package api\n"), 0o644)
	files, err := s.Changes(ctx, "ws1")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range files {
		got[f.Path] = f.Status
	}
	if len(got) != 2 || got["web/README"] == "" || got["api/new.go"] != "untracked" {
		t.Errorf("changes = %v", files)
	}
	diff, err := s.FileDiff(ctx, "ws1", "web/README")
	if err != nil || !strings.Contains(diff, "+there") {
		t.Errorf("diff = %q %v", diff, err)
	}
	if _, err := s.FileDiff(ctx, "ws1", "README"); !errors.Is(err, ErrNotChanged) {
		t.Errorf("a path without its folder = %v, want ErrNotChanged", err)
	}
	f, _ := s.getFacts("ws1")
	if changed, touched, _ := gitStats(ctx, folder, checkoutDirs(folder, f.Checkouts)); changed != 2 || len(touched) != 2 {
		t.Errorf("summary: %d changed, touched %v", changed, touched)
	}

	if err := s.Destroy(ctx, "ws1"); err != nil {
		t.Fatal(err)
	}
	if fileExists(folder) {
		t.Error("the session's folder is still there")
	}
	if out, _ := s.git(ctx, RepoMirrorPath(s.Root, "web"), "worktree", "list"); strings.Contains(out, folder) {
		t.Errorf("the mirror still lists the worktree: %s", out)
	}
}

func TestACheckoutThatFailsTakesTheOthersWithIt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	repoMirror(t, RepoMirrorPath(s.Root, "web"), "main")
	_, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws1",
		Branch:      "b",
		Checkouts:   []Checkout{{Name: "web", BaseBranch: "main"}, {Name: "api", BaseBranch: "main"}}, // no api mirror
	})
	if err == nil || fileExists(s.worktreePath("ws1")) {
		t.Fatalf("create = %v, folder left: %v", err, fileExists(s.worktreePath("ws1")))
	}
	// Once the missing mirror is there, the control plane's retry succeeds:
	// the first attempt left no branch behind.
	repoMirror(t, RepoMirrorPath(s.Root, "api"), "main")
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws1", Branch: "b"}); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !fileExists(filepath.Join(s.worktreePath("ws1"), "api", ".git")) {
		t.Error("the retry made no api checkout")
	}
}

// A session never switches between one repository and several: a retry
// keeps what the first Create recorded.
func TestARetryKeepsTheFirstCreatesRepositories(t *testing.T) {
	s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws1", Branch: "b", BaseBranch: "main"})
	if _, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws1", Branch: "b",
		Checkouts: []Checkout{{Name: "web", BaseBranch: "main"}, {Name: "api", BaseBranch: "main"}},
	}); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws1"); len(f.Checkouts) != 0 {
		t.Errorf("a single-repository session now records checkouts: %v", f.Checkouts)
	}
}

// A folder of the user's (an in-place session) is never scanned for
// repositories: its summary is its own.
func TestASummaryDoesNotScanTheUsersFolder(t *testing.T) {
	folder := t.TempDir()
	repoMirror(t, filepath.Join(folder, "unrelated.git"), "main")
	_ = os.MkdirAll(filepath.Join(folder, "other", ".git"), 0o755)
	if changed, touched, commits := gitStats(context.Background(), folder, nil); changed != 0 || len(touched) != 0 || commits != 0 {
		t.Errorf("stats of a plain folder = %d %v %d", changed, touched, commits)
	}
}

func TestValidCheckouts(t *testing.T) {
	ok := []Checkout{{Name: "web", BaseBranch: "main"}, {Name: "api", BaseBranch: "main"}}
	if err := ValidCheckouts(ok); err != nil {
		t.Fatal(err)
	}
	for name, cs := range map[string][]Checkout{
		"one":         ok[:1],
		"twice":       {ok[0], ok[0]},
		"dot":         {ok[0], {Name: "..", BaseBranch: "main"}},
		"hidden":      {ok[0], {Name: ".git", BaseBranch: "main"}},
		"slash":       {ok[0], {Name: "a/b", BaseBranch: "main"}},
		"no base":     {ok[0], {Name: "api"}},
		"option base": {ok[0], {Name: "api", BaseBranch: "-x"}},
		"more than 5": {{Name: "a", BaseBranch: "m"}, {Name: "b", BaseBranch: "m"}, {Name: "c", BaseBranch: "m"}, {Name: "d", BaseBranch: "m"}, {Name: "e", BaseBranch: "m"}, {Name: "f", BaseBranch: "m"}},
	} {
		if err := ValidCheckouts(cs); !errors.Is(err, ErrInvalidCheckouts) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A restore of a session of several repositories records them: its changes
// and summary span its checkouts again, as a created one's do.
func TestARestoreRecordsTheRepositories(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	id := "s1"
	// No downloads: Materialize fails, but the facts are recorded first.
	_, _ = s.Restore(context.Background(), "ws1", protocol.RestoreWorkspaceRequest{
		Branch: "b", SessionID: &id,
		Repos: []protocol.RepoCheckout{{FullName: "acme/web", Checkout: "web", BaseBranch: "main"}, {FullName: "acme/api", Checkout: "api", BaseBranch: "main"}},
	}, nil)
	if f, _ := s.getFacts("ws1"); len(f.Checkouts) != 2 || f.Checkouts[1].Name != "api" {
		t.Errorf("facts = %+v", f.Checkouts)
	}
	if _, err := s.Restore(context.Background(), "ws2", protocol.RestoreWorkspaceRequest{
		Branch: "b", SessionID: &id,
		Repos: []protocol.RepoCheckout{{Checkout: "../x", BaseBranch: "main"}, {Checkout: "api", BaseBranch: "main"}},
	}, nil); !errors.Is(err, ErrInvalidCheckouts) {
		t.Errorf("bad folder = %v, want ErrInvalidCheckouts", err)
	}
}

// A checkout whose folder went before Destroy is still forgotten by its
// mirror, as is a session whose whole folder went.
func TestDestroyForgetsCheckoutsAlreadyGone(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	repoMirror(t, RepoMirrorPath(s.Root, "web"), "main")
	repoMirror(t, RepoMirrorPath(s.Root, "api"), "main")
	ctx := context.Background()
	for _, id := range []string{"ws1", "ws2"} {
		if _, err := s.Create(ctx, CreateInput{WorkspaceID: id, Branch: "b-" + id, Checkouts: []Checkout{{Name: "web", BaseBranch: "main"}, {Name: "api", BaseBranch: "main"}}}); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.RemoveAll(filepath.Join(s.worktreePath("ws1"), "web"))
	_ = os.RemoveAll(s.worktreePath("ws2"))
	for _, id := range []string{"ws1", "ws2"} {
		if err := s.Destroy(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"web", "api"} {
		if out, _ := s.git(ctx, RepoMirrorPath(s.Root, name), "worktree", "list"); strings.Contains(out, "workspaces") {
			t.Errorf("%s mirror still lists: %s", name, out)
		}
	}
}

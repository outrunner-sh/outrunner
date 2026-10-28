package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mirrorBox gives s a mirror at $ROOT/repo.git as a box has, with origin/main
// at one commit that ignores node_modules.
func mirrorBox(t *testing.T, s *Service) {
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
	run(src, "init", "-q", "-b", "main")
	_ = os.WriteFile(filepath.Join(src, ".gitignore"), []byte("node_modules/\n"), 0o644)
	_ = os.WriteFile(filepath.Join(src, "README"), []byte("hi\n"), 0o644)
	run(src, "add", ".")
	run(src, "commit", "-q", "-m", "init")
	run(s.Root, "clone", "-q", "--bare", src, s.mirrorPath())
	run(s.mirrorPath(), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	run(s.mirrorPath(), "fetch", "-q", "origin")
}

func waitWarm(t *testing.T, s *Service) WarmState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := s.WarmState()
		if st.State != "running" {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatal("warm hook never finished")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A ready box warms a checkout with the project's files and variables, and
// the first session made on it takes the checkout, its ignored work kept, on
// the session's own branch.
func TestASessionTakesTheWarmedCheckout(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	mirrorBox(t, s)

	err := s.Warm(context.Background(), WarmRequest{
		BaseBranch: "main",
		Env:        map[string]string{"GREETING": "hello"},
		Files:      map[string]string{"api/.env": "X=1\n"},
		Hook:       `mkdir -p node_modules && echo "$GREETING" > node_modules/installed && touch stray && echo warmed`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Warm(context.Background(), WarmRequest{BaseBranch: "main"}); err != ErrWarmBusy && s.readWarmState().State == "running" {
		t.Errorf("a second warm while one runs = %v, want ErrWarmBusy", err)
	}
	st := waitWarm(t, s)
	if st.State != "succeeded" || !strings.Contains(st.Log, "warmed") {
		t.Fatalf("warm = %+v", st)
	}
	if fileExists(s.warmEnvPath()) {
		t.Error("the warm hook's variables are kept after it ran")
	}

	wt, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws1", Branch: "runtime/x", BaseBranch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(wt, "node_modules", "installed")); err != nil || string(data) != "hello\n" {
		t.Errorf("the warm hook's work isn't in the session: %q %v", data, err)
	}
	if fileExists(filepath.Join(wt, "stray")) {
		t.Error("an untracked file the hook left is still there")
	}
	if branch, _ := s.git(context.Background(), wt, "symbolic-ref", "--short", "HEAD"); branch != "runtime/x" {
		t.Errorf("branch = %q", branch)
	}
	if f, _ := s.getFacts("ws1"); !f.Warmed {
		t.Error("the session isn't marked warmed: its warm hook would run again")
	}
	if fileExists(s.warmDir()) {
		t.Error("the warm checkout is still there for another session")
	}

	// The next session gets a plain worktree.
	wt2, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws2", Branch: "runtime/y", BaseBranch: "main"})
	if err != nil || fileExists(filepath.Join(wt2, "node_modules")) {
		t.Fatalf("second session: %v, warmed: %v", err, fileExists(filepath.Join(wt2, "node_modules")))
	}
	if f, _ := s.getFacts("ws2"); f.Warmed {
		t.Error("a plain worktree is marked warmed")
	}
}

// A failed warm hook leaves nothing for a session to take.
func TestAFailedWarmIsNotTaken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	mirrorBox(t, s)
	if err := s.Warm(context.Background(), WarmRequest{BaseBranch: "main", Hook: "echo nope; exit 3"}); err != nil {
		t.Fatal(err)
	}
	if st := waitWarm(t, s); st.State != "failed" || st.ExitCode != 3 {
		t.Fatalf("warm = %+v", st)
	}
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws1", Branch: "b", BaseBranch: "main"}); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws1"); f.Warmed {
		t.Error("took a failed warm")
	}
}

// A session's scripts run in order: the warm hook once (not on a warmed
// worktree), the setup script once, the start hook at every launch.
func TestSessionScriptsRunInOrder(t *testing.T) {
	s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws1", Branch: "b", BaseBranch: "main"})
	if err := s.SetHooks("ws1", "echo warm >> order", "echo start >> order"); err != nil {
		t.Fatal(err)
	}
	if err := writeKeysFile(s.setupPath("ws1"), "echo setup >> order"); err != nil {
		t.Fatal(err)
	}
	order := filepath.Join(wt, "order")
	waitFor := func(want string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			data, _ := os.ReadFile(order)
			if string(data) == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("order = %q, want %q", data, want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	s.startSetup("ws1", wt, nil)
	waitFor("warm\nsetup\nstart\n")
	s.startSetup("ws1", wt, nil)
	waitFor("warm\nsetup\nstart\nstart\n")

	// A warmed session never runs the warm hook.
	f, _ := s.getFacts("ws1")
	f.Warmed = true
	s.setFacts("ws1", f)
	_ = os.Remove(order)
	_ = s.SetHooks("ws1", "echo warm >> order", "echo start >> order")
	s.startSetup("ws1", wt, nil)
	waitFor("start\n")
}

// twoRepoBox gives s the mirrors of a project of two repositories, web on
// main and api on develop, and the checkouts its sessions are made of.
func twoRepoBox(t *testing.T, s *Service) []Checkout {
	t.Helper()
	repoMirror(t, RepoMirrorPath(s.Root, "web"), "main")
	repoMirror(t, RepoMirrorPath(s.Root, "api"), "develop")
	return []Checkout{
		{Name: "web", FullName: "acme/web", BaseBranch: "main"},
		{Name: "api", FullName: "acme/api", BaseBranch: "develop"},
	}
}

// A ready box of a project of several repositories is warmed in a folder of
// their checkouts, the hook run at its root as a session's is, and a session
// of the same repositories takes the folder: each checkout on the session's
// branch, its ignored work kept.
func TestASessionOfSeveralRepositoriesTakesTheWarmedFolder(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	checkouts := twoRepoBox(t, s)
	ctx := context.Background()

	err := s.Warm(ctx, WarmRequest{
		Env:       map[string]string{"GREETING": "hello"},
		Files:     map[string]string{"api/.env": "X=1\n"},
		Hook:      `test -f web/README && test -f api/.env && mkdir -p web/node_modules && echo "$GREETING" > web/node_modules/installed && touch api/stray && echo root > shared`,
		Checkouts: checkouts,
	})
	if err != nil {
		t.Fatal(err)
	}
	st := waitWarm(t, s)
	if st.State != "succeeded" || st.BaseBranch != "main" || len(st.Checkouts) != 2 {
		t.Fatalf("warm = %+v", st)
	}

	folder, err := s.Create(ctx, CreateInput{
		WorkspaceID: "ws1",
		Branch:      "runtime/x",
		GitUser:     &GitUser{Name: "Ada", Email: "ada@example.com"},
		Checkouts:   checkouts,
	})
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(folder, "web", "node_modules", "installed")); err != nil || string(data) != "hello\n" {
		t.Errorf("the warm hook's work isn't in the session: %q %v", data, err)
	}
	if data, _ := os.ReadFile(filepath.Join(folder, "shared")); string(data) != "root\n" {
		t.Errorf("what the hook made at the folder's root went: %q", data)
	}
	if fileExists(filepath.Join(folder, "api", "stray")) {
		t.Error("an untracked file the hook left is still there")
	}
	for _, c := range checkouts {
		dir := filepath.Join(folder, c.Name)
		if branch, _ := s.git(ctx, dir, "symbolic-ref", "--short", "HEAD"); branch != "runtime/x" {
			t.Errorf("%s branch = %q", c.Name, branch)
		}
		if email, _ := s.git(ctx, dir, "config", "user.email"); email != "ada@example.com" {
			t.Errorf("%s user = %q", c.Name, email)
		}
		if out, _ := s.git(ctx, RepoMirrorPath(s.Root, c.Name), "worktree", "list"); !strings.Contains(out, dir) || strings.Contains(out, s.warmDir()) {
			t.Errorf("%s's mirror doesn't know where its checkout went: %s", c.Name, out)
		}
	}
	if f, _ := s.getFacts("ws1"); !f.Warmed {
		t.Error("the session isn't marked warmed: its warm hook would run again")
	}
	if fileExists(s.warmDir()) {
		t.Error("the warm folder is still there for another session")
	}

	// It goes as any session of several repositories does.
	if err := s.Destroy(ctx, "ws1"); err != nil {
		t.Fatal(err)
	}
	for _, c := range checkouts {
		if out, _ := s.git(ctx, RepoMirrorPath(s.Root, c.Name), "worktree", "list"); strings.Contains(out, folder) {
			t.Errorf("%s's mirror still lists the session: %s", c.Name, out)
		}
	}
}

// A session whose repositories aren't those the box was warmed with (one
// from another base, or a session of one) makes its own, and leaves the
// warm work alone.
func TestAWarmOfOtherRepositoriesIsNotTaken(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	checkouts := twoRepoBox(t, s)
	mirrorBox(t, s)
	ctx := context.Background()
	if err := s.Warm(ctx, WarmRequest{Hook: "mkdir -p web/node_modules", Checkouts: checkouts}); err != nil {
		t.Fatal(err)
	}
	if st := waitWarm(t, s); st.State != "succeeded" {
		t.Fatalf("warm = %+v", st)
	}

	// api from main rather than develop: the folder isn't the one warmed.
	_, _ = s.git(ctx, RepoMirrorPath(s.Root, "api"), "update-ref", "refs/remotes/origin/main", "refs/remotes/origin/develop")
	other := []Checkout{checkouts[0], {Name: "api", FullName: "acme/api", BaseBranch: "main"}}
	folder, err := s.Create(ctx, CreateInput{WorkspaceID: "ws1", Branch: "b1", Checkouts: other})
	if err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws1"); f.Warmed || fileExists(filepath.Join(folder, "web", "node_modules")) {
		t.Error("took a folder warmed from another base")
	}
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws2", Branch: "b2", BaseBranch: "main"}); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws2"); f.Warmed {
		t.Error("a session of one repository took a folder of several")
	}
	if !fileExists(s.warmDir()) || s.readWarmState().State != "succeeded" {
		t.Error("the warm work went with a session that didn't take it")
	}

	// Nor does a session of several take one checkout warmed alone.
	if err := s.Warm(ctx, WarmRequest{BaseBranch: "main", Hook: "true"}); err != nil {
		t.Fatal(err)
	}
	waitWarm(t, s)
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws3", Branch: "b3", Checkouts: checkouts}); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws3"); f.Warmed {
		t.Error("a session of several repositories took a single checkout")
	}
}

// A warm folder that can't be taken whole is discarded, the branches it made
// with it, and the session's checkouts are made as usual.
func TestAWarmFolderThatFailsHalfWayFallsBack(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	checkouts := twoRepoBox(t, s)
	ctx := context.Background()
	if err := s.Warm(ctx, WarmRequest{Hook: "mkdir -p web/node_modules api/node_modules", Checkouts: checkouts}); err != nil {
		t.Fatal(err)
	}
	waitWarm(t, s)
	// web switches to the session's branch; api, no longer a checkout, can't.
	if err := os.Remove(filepath.Join(s.warmDir(), "api", ".git")); err != nil {
		t.Fatal(err)
	}

	folder, err := s.Create(ctx, CreateInput{WorkspaceID: "ws1", Branch: "runtime/x", Checkouts: checkouts})
	if err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws1"); f.Warmed {
		t.Error("a folder that failed half way is marked warmed")
	}
	for _, c := range checkouts {
		dir := filepath.Join(folder, c.Name)
		if branch, _ := s.git(ctx, dir, "symbolic-ref", "--short", "HEAD"); branch != "runtime/x" {
			t.Errorf("%s branch = %q", c.Name, branch)
		}
		if fileExists(filepath.Join(dir, "node_modules")) {
			t.Errorf("%s kept the failed warm's work", c.Name)
		}
	}
	if fileExists(s.warmDir()) || s.readWarmState().State != "" {
		t.Error("the failed warm folder is still there")
	}
}

// A Create cut off while it takes the warm folder (its request ended) still
// takes back every branch the adoption made, so its retry can make the
// session's checkouts.
func TestAWarmFolderCutOffHalfWayLeavesNoBranches(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	checkouts := twoRepoBox(t, s)
	if err := s.Warm(context.Background(), WarmRequest{Hook: "true", Checkouts: checkouts}); err != nil {
		t.Fatal(err)
	}
	waitWarm(t, s)
	// web switches to the session's branch; api's switch outlasts the request.
	marker := slowCheckouts(t, RepoMirrorPath(s.Root, "api"))

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws1", Branch: "runtime/x", Checkouts: checkouts}); err == nil {
		t.Fatal("a Create whose request ended made its checkouts")
	}
	for _, c := range checkouts {
		if _, err := s.git(context.Background(), RepoMirrorPath(s.Root, c.Name), "rev-parse", "--verify", "--quiet", "refs/heads/runtime/x"); err == nil {
			t.Errorf("%s's mirror kept the session's branch", c.Name)
		}
	}

	_ = os.Remove(marker)
	folder, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws1", Branch: "runtime/x", Checkouts: checkouts})
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	for _, c := range checkouts {
		if branch, _ := s.git(context.Background(), filepath.Join(folder, c.Name), "symbolic-ref", "--short", "HEAD"); branch != "runtime/x" {
			t.Errorf("%s branch = %q", c.Name, branch)
		}
	}
}

// A Create whose request has ended leaves the warm for its retry, and a
// session's branch already in a mirror is neither adopted over nor taken
// back.
func TestAWarmFolderIsLeftForARetryAndAnotherBranch(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	checkouts := twoRepoBox(t, s)
	if err := s.Warm(context.Background(), WarmRequest{Hook: "mkdir -p web/node_modules", Checkouts: checkouts}); err != nil {
		t.Fatal(err)
	}
	waitWarm(t, s)

	done, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Create(done, CreateInput{WorkspaceID: "ws1", Branch: "runtime/x", Checkouts: checkouts}); err == nil {
		t.Fatal("a Create whose request ended made its checkouts")
	}
	if !fileExists(s.warmDir()) || s.readWarmState().State != "succeeded" {
		t.Fatal("a Create whose request ended threw the warm away")
	}

	ctx := context.Background()
	web := RepoMirrorPath(s.Root, "web")
	if _, err := s.git(ctx, web, "branch", "runtime/y", "origin/main"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws2", Branch: "runtime/y", Checkouts: checkouts}); err == nil {
		t.Fatal("made checkouts on a branch already there")
	}
	if s.branchMissing(ctx, web, "runtime/y") {
		t.Error("a branch the session didn't make was deleted")
	}
	if !fileExists(s.warmDir()) {
		t.Error("the warm was adopted over a branch already there")
	}

	// The retry takes it.
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: "ws1", Branch: "runtime/x", Checkouts: checkouts}); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.getFacts("ws1"); !f.Warmed {
		t.Error("the retry didn't take the warm")
	}
}

// A warm folder whose checkout can't be made leaves nothing behind: the next
// warm makes it again.
func TestAWarmFolderThatCantBeMadeLeavesNothing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	repoMirror(t, RepoMirrorPath(s.Root, "web"), "main")
	checkouts := []Checkout{{Name: "web", BaseBranch: "main"}, {Name: "api", BaseBranch: "main"}} // no api mirror
	ctx := context.Background()
	if err := s.Warm(ctx, WarmRequest{Hook: "true", Checkouts: checkouts}); err == nil || fileExists(s.warmDir()) {
		t.Fatalf("warm = %v, folder left: %v", err, fileExists(s.warmDir()))
	}
	repoMirror(t, RepoMirrorPath(s.Root, "api"), "main")
	if err := s.Warm(ctx, WarmRequest{Hook: "true", Checkouts: checkouts}); err != nil {
		t.Fatalf("the next warm: %v", err)
	}
	if st := waitWarm(t, s); st.State != "succeeded" {
		t.Fatalf("warm = %+v", st)
	}
	if err := s.Warm(ctx, WarmRequest{Checkouts: checkouts[:1]}); !errors.Is(err, ErrInvalidCheckouts) {
		t.Errorf("a folder of one = %v, want ErrInvalidCheckouts", err)
	}
}

// A warm cut off half way (its request ended) leaves no checkout its mirror
// still lists, and one left listed anyway, its folder gone, heals at the
// next warm: either would refuse it.
func TestAWarmCutOffHalfWayCanBeWarmedAgain(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	checkouts := twoRepoBox(t, s)
	marker := slowCheckouts(t, RepoMirrorPath(s.Root, "api"))

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Warm(ctx, WarmRequest{Hook: "true", Checkouts: checkouts}); err == nil || fileExists(s.warmDir()) {
		t.Fatalf("warm = %v, folder left: %v", err, fileExists(s.warmDir()))
	}
	_ = os.Remove(marker)
	if err := s.Warm(context.Background(), WarmRequest{Hook: "true", Checkouts: checkouts}); err != nil {
		t.Fatalf("the next warm: %v", err)
	}
	waitWarm(t, s)

	// A registration whose folder went before anything pruned it.
	_ = os.RemoveAll(s.warmDir())
	_ = os.Remove(s.warmStatePath())
	if err := s.Warm(context.Background(), WarmRequest{Hook: "true", Checkouts: checkouts}); err != nil {
		t.Fatalf("a warm after a folder went unpruned: %v", err)
	}
	if st := waitWarm(t, s); st.State != "succeeded" {
		t.Fatalf("warm = %+v", st)
	}
}

func TestSameCheckouts(t *testing.T) {
	web, api := Checkout{Name: "web", FullName: "acme/web", BaseBranch: "main"}, Checkout{Name: "api", FullName: "acme/api", BaseBranch: "main"}
	if !sameCheckouts([]Checkout{web, api}, []Checkout{api, web}) {
		t.Error("the same repositories in another order lay out the same folder")
	}
	moved := api
	moved.FullName = "acme/backend"
	for name, b := range map[string][]Checkout{
		"other base":       {web, {Name: "api", FullName: "acme/api", BaseBranch: "develop"}},
		"other repository": {web, moved},
		"one more":         {web, api, {Name: "docs", BaseBranch: "main"}},
		"none":             nil,
	} {
		if sameCheckouts([]Checkout{web, api}, b) {
			t.Errorf("%s: taken as the same", name)
		}
	}
	if sameCheckouts(nil, nil) {
		t.Error("no repositories (a single checkout's warm) taken as a folder's")
	}
}

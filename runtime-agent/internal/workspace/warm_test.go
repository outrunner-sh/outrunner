package workspace

import (
	"context"
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

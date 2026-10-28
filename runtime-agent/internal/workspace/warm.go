package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/claude"
)

// A ready box (the control plane's warm pool) is warmed before any session
// takes it: a checkout of the project's base branch, off the box's mirror,
// with the project's files laid out in it and its warm hook run there (a
// dependency install, a build). The first session made on the box takes that
// checkout as its worktree (adoptWarm): moved into place and switched to the
// session's branch, with what git ignores (node_modules, build output) kept,
// so the session starts with the work done.
//
// A project of several repositories is warmed as its sessions are laid out
// (checkouts.go): a folder of checkouts, one a repository off its mirror at
// $ROOT/repos/<checkout>.git, with the hook run at the folder's root, where a
// session runs it. A session of the same repositories takes the folder
// (adoptWarmCheckouts); any other session leaves it.
//
// The hook runs beside the agent; the control plane starts it (Warm) and
// asks how it went (WarmState) until it ends.

// WarmTimeout bounds a warm hook's run.
const WarmTimeout = 60 * time.Minute

// warmLogTail is how much of the warm log WarmState returns.
const warmLogTail = 64 << 10

// ErrWarmBusy is a warm started while one runs.
var ErrWarmBusy = errors.New("the box is already being warmed")

// WarmRequest is what a box is warmed with: the base branch sessions start
// from, the project's variables and files, and its warm hook.
type WarmRequest struct {
	BaseBranch string
	Env        map[string]string
	Files      map[string]string
	Hook       string
	// Checkouts, when set, warm a folder of them, as a session of several
	// repositories has (checkouts.go). BaseBranch is then the first's.
	Checkouts []Checkout
}

// WarmState is how the box's warming went: State is "" (never warmed),
// "running", "succeeded" or "failed".
type WarmState struct {
	State      string `json:"state"`
	BaseBranch string `json:"baseBranch,omitempty"`
	// Checkouts are the repositories a folder of checkouts was warmed with;
	// none for one checkout. Only a session of the same takes it.
	Checkouts  []Checkout `json:"checkouts,omitempty"`
	StartedAt  string     `json:"startedAt,omitempty"`
	FinishedAt string     `json:"finishedAt,omitempty"`
	ExitCode   int        `json:"exitCode,omitempty"`
	// Log is the end of the hook's output (WarmState only).
	Log string `json:"log,omitempty"`
}

var warmMu sync.Mutex

func (s *Service) warmDir() string       { return filepath.Join(s.Root, "warm-checkout") }
func (s *Service) warmStatePath() string { return filepath.Join(s.Root, "warm", "state.json") }
func (s *Service) warmEnvPath() string   { return filepath.Join(s.Root, "warm", "env") }
func (s *Service) warmHookFile() string  { return filepath.Join(s.Root, "warm", "hook.sh") }
func (s *Service) warmLogPath() string   { return filepath.Join(s.Root, "logs", "warm.log") }

// Warm starts warming the box: a fresh checkout of req.BaseBranch (or a
// folder of req.Checkouts) with the files in it, and the hook run there in
// the background (WarmState says how it went). One that runs already is
// ErrWarmBusy; anything warmed before is replaced.
func (s *Service) Warm(ctx context.Context, req WarmRequest) error {
	if len(req.Checkouts) > 0 {
		if err := ValidCheckouts(req.Checkouts); err != nil {
			return err
		}
		req.BaseBranch = req.Checkouts[0].BaseBranch
	}
	if req.BaseBranch == "" || strings.HasPrefix(req.BaseBranch, "-") {
		return fmt.Errorf("%w: a base branch", ErrInvalidEnvironment)
	}
	names := make([]string, 0, len(req.Env))
	for name, value := range req.Env {
		if !ValidEnvName(name) || strings.ContainsRune(value, 0) {
			return fmt.Errorf("%w: %s can't be set", ErrInvalidEnvironment, name)
		}
		names = append(names, name)
	}
	if err := validEnvFiles(req.Files); err != nil {
		return err
	}
	if err := ValidHooks(req.Hook, ""); err != nil {
		return err
	}

	warmMu.Lock()
	defer warmMu.Unlock()
	if s.readWarmState().State == "running" {
		return ErrWarmBusy
	}
	dir := s.warmDir()
	s.discardWarm(ctx)
	if len(req.Checkouts) > 0 {
		if err := s.warmCheckouts(ctx, dir, req.Checkouts); err != nil {
			s.discardWarm(ctx)
			return err
		}
	} else if out, err := exec.CommandContext(ctx, "git", "-C", s.mirrorPath(),
		"worktree", "add", "--detach", dir, "origin/"+req.BaseBranch).CombinedOutput(); err != nil {
		return fmt.Errorf("warm checkout: %v: %s", err, strings.TrimSpace(string(out)))
	}
	for path, content := range req.Files {
		dst := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, []byte(content), 0o600); err != nil {
			return err
		}
	}
	sort.Strings(names)
	var env strings.Builder
	for _, name := range names {
		env.WriteString("export " + name + "=" + claude.ShellQuote(req.Env[name]) + "\n")
	}
	if err := writeKeysFile(s.warmEnvPath(), env.String()); err != nil {
		return err
	}
	if err := writeKeysFile(s.warmHookFile(), req.Hook); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.warmLogPath()), 0o700); err != nil {
		return err
	}
	log, err := os.OpenFile(s.warmLogPath(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	state := WarmState{State: "running", BaseBranch: req.BaseBranch, Checkouts: req.Checkouts, StartedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := s.writeWarmState(state); err != nil {
		log.Close()
		return err
	}
	go s.runWarmHook(state, log)
	return nil
}

// warmCheckouts makes the folder of checkouts a box is warmed in, each
// detached at its base off its own mirror, as createCheckouts lays out a
// session's.
func (s *Service) warmCheckouts(ctx context.Context, dir string, checkouts []Checkout) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, c := range checkouts {
		if out, err := exec.CommandContext(ctx, "git", "-C", RepoMirrorPath(s.Root, c.Name),
			"worktree", "add", "--detach", filepath.Join(dir, c.Name), "origin/"+c.BaseBranch).CombinedOutput(); err != nil {
			return fmt.Errorf("warm checkout %s: %v: %s", c.Name, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

func (s *Service) runWarmHook(state WarmState, log *os.File) {
	defer log.Close()
	ctx, cancel := context.WithTimeout(context.Background(), WarmTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", `. "$1" && exec sh "$2"`, "sh", s.warmEnvPath(), s.warmHookFile())
	cmd.Dir = s.warmDir()
	// The sessions' environment, not the agent's own: its secrets aren't the hook's.
	cmd.Env = append([]string(nil), s.env...)
	cmd.Stdout, cmd.Stderr = log, log
	err := cmd.Run()
	state.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	state.State = "succeeded"
	if err != nil {
		state.State = "failed"
		state.ExitCode = -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			state.ExitCode = exit.ExitCode()
		}
		if ctx.Err() != nil {
			fmt.Fprintf(log, "\nwarm hook timed out after %s\n", WarmTimeout)
		} else {
			fmt.Fprintf(log, "\nwarm hook failed: %v\n", err)
		}
	}
	_ = os.Remove(s.warmEnvPath()) // its secrets aren't needed once it ran
	_ = s.writeWarmState(state)
}

// WarmState is how the box's warming went, with the end of its log.
func (s *Service) WarmState() WarmState {
	state := s.readWarmState()
	if f, err := os.Open(s.warmLogPath()); err == nil {
		defer f.Close()
		if info, err := f.Stat(); err == nil && info.Size() > warmLogTail {
			_, _ = f.Seek(info.Size()-warmLogTail, io.SeekStart)
		}
		data, _ := io.ReadAll(f)
		state.Log = string(data)
	}
	return state
}

func (s *Service) readWarmState() WarmState {
	var state WarmState
	if data, err := os.ReadFile(s.warmStatePath()); err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return state
}

func (s *Service) writeWarmState(state WarmState) error {
	return writeJSONFile(s.warmStatePath(), state, 0o600)
}

// discardWarm removes a warmed checkout (or folder of them) nobody took.
func (s *Service) discardWarm(ctx context.Context) {
	dir := s.warmDir()
	if fileExists(dir) {
		_ = exec.CommandContext(ctx, "git", "-C", s.mirrorPath(), "worktree", "remove", "--force", dir).Run()
		_ = os.RemoveAll(dir)
		_ = exec.CommandContext(ctx, "git", "-C", s.mirrorPath(), "worktree", "prune").Run()
		// Every repository's mirror, not only those the state names: a warm
		// cut off before its state was written leaves checkouts too, and a
		// mirror still listing one refuses the next warm's.
		mirrors, _ := filepath.Glob(filepath.Join(s.Root, "repos", "*.git"))
		for _, mirror := range mirrors {
			_ = exec.CommandContext(ctx, "git", "-C", mirror, "worktree", "prune").Run()
		}
	}
	_ = os.Remove(s.warmStatePath())
}

// adoptWarm makes the box's warmed checkout the new session's worktree: only
// one warmed from base whose hook succeeded. Moved into place, switched to a
// new branch at origin/base (fetched since: the box was taken from the pool),
// and cleaned of what git tracks or would (what it ignores stays: the warm
// hook's work). Whether it did; one that fails half way is discarded, and the
// session's worktree is made as usual.
func (s *Service) adoptWarm(ctx context.Context, worktree, branch, base string) bool {
	warmMu.Lock()
	defer warmMu.Unlock()
	state := s.readWarmState()
	if state.State != "succeeded" || state.BaseBranch != base || len(state.Checkouts) > 0 || !fileExists(s.warmDir()) {
		return false
	}
	steps := [][]string{
		{"-C", s.mirrorPath(), "worktree", "move", s.warmDir(), worktree},
		{"-C", worktree, "checkout", "--force", "-B", branch, "origin/" + base},
		{"-C", worktree, "clean", "-fd"},
	}
	for i, args := range steps {
		if out, err := exec.CommandContext(ctx, "git", args...).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "adopting the warm checkout: git %s: %v: %s\n", strings.Join(args, " "), err, out)
			cleanup, cancel := cleanupContext(ctx)
			defer cancel()
			if i > 0 {
				_ = exec.CommandContext(cleanup, "git", "-C", s.mirrorPath(), "worktree", "remove", "--force", worktree).Run()
				_ = os.RemoveAll(worktree)
			}
			s.discardWarm(cleanup)
			return false
		}
	}
	_ = os.Remove(s.warmStatePath())
	return true
}

// adoptWarmCheckouts makes the box's warmed folder of checkouts the new
// session's, as adoptWarm does one checkout: only one warmed with the same
// repositories (folders, repositories and base branches) whose hook
// succeeded. Moved into place whole (what the hook made at its root stays
// too), each checkout's mirror told where it went, and each switched to a new
// branch at its origin/base and cleaned of what git tracks or would. Whether
// it did; one that fails half way is discarded, every checkout and branch it
// made going with it, and the session's checkouts are made as usual. A
// session's branch already in one of the mirrors isn't adopted over: its
// checkouts can't be made on it either (createCheckouts says why), and the
// branches a failed adoption takes back are only ever its own.
func (s *Service) adoptWarmCheckouts(ctx context.Context, folder, branch string, checkouts []Checkout) bool {
	warmMu.Lock()
	defer warmMu.Unlock()
	state := s.readWarmState()
	if state.State != "succeeded" || !sameCheckouts(state.Checkouts, checkouts) || !fileExists(s.warmDir()) {
		return false
	}
	for _, c := range checkouts {
		if _, err := s.git(ctx, RepoMirrorPath(s.Root, c.Name), "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
			return false
		}
	}
	if err := os.Rename(s.warmDir(), folder); err != nil {
		fmt.Fprintf(os.Stderr, "adopting the warm checkouts: %v\n", err)
		cleanup, cancel := cleanupContext(ctx)
		defer cancel()
		s.discardWarm(cleanup)
		return false
	}
	for _, c := range checkouts {
		dir, mirror := filepath.Join(folder, c.Name), RepoMirrorPath(s.Root, c.Name)
		for _, args := range [][]string{
			{"-C", mirror, "worktree", "repair", dir},
			{"-C", dir, "checkout", "--force", "-B", branch, "origin/" + c.BaseBranch},
			{"-C", dir, "clean", "-fd"},
		} {
			if out, err := exec.CommandContext(ctx, "git", args...).CombinedOutput(); err != nil {
				fmt.Fprintf(os.Stderr, "adopting the warm checkouts: git %s: %v: %s\n", strings.Join(args, " "), err, out)
				// Every checkout and branch, whichever it reached: none of
				// the branches was there before (above).
				s.undoCheckouts(ctx, folder, branch, checkouts)
				cleanup, cancel := cleanupContext(ctx)
				defer cancel()
				s.discardWarm(cleanup)
				return false
			}
		}
	}
	_ = os.Remove(s.warmStatePath())
	return true
}

// sameCheckouts reports whether two sets of repositories lay out the same
// folder, in whatever order.
func sameCheckouts(a, b []Checkout) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	byName := make(map[string]Checkout, len(a))
	for _, c := range a {
		byName[c.Name] = c
	}
	for _, c := range b {
		if w, ok := byName[c.Name]; !ok || w != c {
			return false
		}
	}
	return true
}

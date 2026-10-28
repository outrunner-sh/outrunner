package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A session of a project with several repositories works in a folder of
// checkouts: $ROOT/workspaces/<id>/<checkout>, one worktree a repository, each
// off its own mirror at $ROOT/repos/<checkout>.git and on the session's branch.
// The agent works in the folder. A session of one repository is as before: its
// worktree is the folder itself, off $ROOT/repo.git.

// MaxCheckouts is how many repositories a session holds at most.
const MaxCheckouts = 5

// checkoutName is a folder a repository is cloned into.
var checkoutName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

// ErrInvalidCheckouts is a set of repositories a session can't take.
var ErrInvalidCheckouts = errors.New("invalid repositories")

// Checkout is one repository of a session: its folder and the branch its
// worktree starts from.
type Checkout struct {
	Name       string `json:"name"`
	FullName   string `json:"fullName,omitempty"`
	BaseBranch string `json:"baseBranch"`
}

// ValidCheckouts accepts a session's repositories: 2 to MaxCheckouts, each
// with a distinct, safe folder name and a base branch.
func ValidCheckouts(checkouts []Checkout) error {
	if len(checkouts) < 2 || len(checkouts) > MaxCheckouts {
		return fmt.Errorf("%w: 2 to %d, not %d", ErrInvalidCheckouts, MaxCheckouts, len(checkouts))
	}
	seen := map[string]bool{}
	for _, c := range checkouts {
		if !checkoutName.MatchString(c.Name) || c.Name == "." || c.Name == ".." || strings.HasPrefix(c.Name, ".") {
			return fmt.Errorf("%w: folder %q", ErrInvalidCheckouts, c.Name)
		}
		if seen[c.Name] {
			return fmt.Errorf("%w: folder %q twice", ErrInvalidCheckouts, c.Name)
		}
		seen[c.Name] = true
		if c.BaseBranch == "" || strings.HasPrefix(c.BaseBranch, "-") {
			return fmt.Errorf("%w: %s's base branch", ErrInvalidCheckouts, c.Name)
		}
	}
	return nil
}

// RepoMirrorPath is where a repository of a multi-repository project is
// mirrored on the box, cloned there by the control plane.
func RepoMirrorPath(root, checkout string) string {
	return filepath.Join(root, "repos", checkout+".git")
}

// cleanupTimeout bounds taking back what a step cut off half way made.
const cleanupTimeout = 30 * time.Second

// cleanupContext is the context to take back a half-made step on: ctx's
// values without its end. The request's context may be done already (often
// why the step failed), and git won't start on one that is, so a cleanup on
// it would leave branches a retry trips over.
func cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
}

// undoCheckouts takes back checkouts made in folder on branch: each leaves
// its mirror, then its branch goes (a retry makes them again with -b), then
// the folder.
func (s *Service) undoCheckouts(ctx context.Context, folder, branch string, checkouts []Checkout) {
	ctx, cancel := cleanupContext(ctx)
	defer cancel()
	for _, c := range checkouts {
		s.removeCheckout(ctx, folder, c)
	}
	for _, c := range checkouts {
		_, _ = s.git(ctx, RepoMirrorPath(s.Root, c.Name), "branch", "-D", branch)
	}
	_ = os.RemoveAll(folder)
}

// undoWorktree takes back a session's worktree of the box's one repository,
// as undoCheckouts does a folder of them: it leaves the mirror, then the
// folder goes, then its branch, when it is the session's own (ours) to take
// back.
func (s *Service) undoWorktree(ctx context.Context, worktree, branch string, ours bool) {
	ctx, cancel := cleanupContext(ctx)
	defer cancel()
	_, _ = s.git(ctx, s.mirrorPath(), "worktree", "remove", "--force", worktree)
	_ = os.RemoveAll(worktree)
	_, _ = s.git(ctx, s.mirrorPath(), "worktree", "prune")
	if ours {
		_, _ = s.git(ctx, s.mirrorPath(), "branch", "-D", branch)
	}
}

// branchMissing reports whether mirror surely has no branch: git looked and
// found none (rev-parse's exit 1), not merely failed to say (a request that
// ended, a mirror that isn't there).
func (s *Service) branchMissing(ctx context.Context, mirror, branch string) bool {
	err := exec.CommandContext(ctx, "git", "-C", mirror, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Run()
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == 1
}

// createCheckouts makes the session's folder of worktrees, all on branch.
// One that fails takes the others it made with it, and itself when the
// branch is its own: worktree add makes the branch before the tree, so one
// cut off half way leaves both.
func (s *Service) createCheckouts(ctx context.Context, folder, branch string, checkouts []Checkout, user *GitUser) error {
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	var made []Checkout
	for _, c := range checkouts {
		dir, mirror := filepath.Join(folder, c.Name), RepoMirrorPath(s.Root, c.Name)
		// A branch that wasn't there before is this add's to take back; one
		// that was (the add fails on it) isn't.
		ours := s.branchMissing(ctx, mirror, branch)
		out, err := exec.CommandContext(ctx, "git", "-C", mirror,
			"worktree", "add", "-b", branch, dir, "origin/"+c.BaseBranch).CombinedOutput()
		if err != nil {
			undo := made
			if ours {
				undo = append(undo[:len(undo):len(undo)], c)
			}
			s.undoCheckouts(ctx, folder, branch, undo)
			return fmt.Errorf("worktree add %s: %v: %s", c.Name, err, strings.TrimSpace(string(out)))
		}
		made = append(made, c)
		setGitUser(ctx, dir, user)
	}
	return nil
}

// removeCheckout removes one checkout from its mirror, known from its name:
// even when its folder (or its .git) has gone already, the mirror forgets it.
func (s *Service) removeCheckout(ctx context.Context, folder string, c Checkout) {
	dir, mirror := filepath.Join(folder, c.Name), RepoMirrorPath(s.Root, c.Name)
	_, _ = s.git(ctx, mirror, "worktree", "remove", "--force", dir)
	_ = os.RemoveAll(dir)
	_, _ = s.git(ctx, mirror, "worktree", "prune")
}

// checkoutDirs are the checkouts of a session of several repositories, in
// the order recorded; nil for any other session (its worktree is its one
// repository, or a folder of the user's that isn't Outrunner's to scan).
// Driven by the facts, never by what is on disk.
func checkoutDirs(worktree string, checkouts []Checkout) []string {
	if worktree == "" || len(checkouts) == 0 {
		return nil
	}
	dirs := make([]string, len(checkouts))
	for i, c := range checkouts {
		dirs[i] = filepath.Join(worktree, c.Name)
	}
	return dirs
}

// checkoutsNote tells the agent about a session's checkouts, after its
// orientation: where each is, what it targets.
func checkoutsNote(checkouts []Checkout, branch string) string {
	var b strings.Builder
	b.WriteString("# Repositories\n\nThis session works on several repositories, each a git checkout in its own folder of the working directory, all on the branch " + branch + ":\n\n")
	for _, c := range checkouts {
		name := c.FullName
		if name == "" {
			name = c.Name
		}
		fmt.Fprintf(&b, "- `%s/`: %s, targeting origin/%s\n", c.Name, name, c.BaseBranch)
	}
	b.WriteString("\nThe working directory itself is not a repository: run git in a checkout (`git -C <folder> ...`), and diff, commit, push and open pull requests in each repository you changed, against its own target branch.")
	return b.String()
}

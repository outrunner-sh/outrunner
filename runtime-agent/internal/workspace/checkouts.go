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

// createCheckouts makes the session's folder of worktrees, all on branch.
// One that fails takes the others it made with it.
func (s *Service) createCheckouts(ctx context.Context, folder, branch string, checkouts []Checkout, user *GitUser) error {
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	var made []Checkout
	for _, c := range checkouts {
		dir := filepath.Join(folder, c.Name)
		out, err := exec.CommandContext(ctx, "git", "-C", RepoMirrorPath(s.Root, c.Name),
			"worktree", "add", "-b", branch, dir, "origin/"+c.BaseBranch).CombinedOutput()
		if err != nil {
			// Their branches too: a retry makes them again with -b.
			for _, m := range made {
				s.removeCheckout(ctx, folder, m)
				_, _ = s.git(ctx, RepoMirrorPath(s.Root, m.Name), "branch", "-D", branch)
			}
			_ = os.RemoveAll(folder)
			return fmt.Errorf("worktree add %s: %v: %s", c.Name, err, strings.TrimSpace(string(out)))
		}
		made = append(made, c)
		if user != nil && user.Name != "" && user.Email != "" {
			_ = exec.CommandContext(ctx, "git", "-C", dir, "config", "user.name", user.Name).Run()
			_ = exec.CommandContext(ctx, "git", "-C", dir, "config", "user.email", user.Email).Run()
		}
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

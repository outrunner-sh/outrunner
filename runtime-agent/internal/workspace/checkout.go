package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// A local session branches from the user's own clone instead of a bare mirror
// the agent owns. That clone is theirs: it has their remotes, their credentials
// and possibly no network, so every step here is either read-only or creates
// something new (a branch, a worktree) — nothing already in it is changed.

// fetchTimeout bounds the best-effort refresh of the base branch. A fetch that
// needs credentials nobody can type, or a remote that does not answer, must not
// hold up the session.
const fetchTimeout = 30 * time.Second

// localFolder is what Create learns about the folder a local session works on.
type localFolder struct {
	// path is the repository's top level for a git folder, else as given.
	path string
	// git is true for a repository with at least one commit to branch from.
	git bool
	// branch is the checked-out branch, empty when detached or not git.
	branch string
}

// inspectFolder checks the folder a local session was pointed at. Any folder
// will do: one that is not a repository — or is one with no commit yet, which
// has nothing to branch — is worked on in place.
func (s *Service) inspectFolder(ctx context.Context, path string) (localFolder, error) {
	if !filepath.IsAbs(path) {
		return localFolder{}, fmt.Errorf("folder path must be absolute, got %q", path)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return localFolder{}, fmt.Errorf("%s is not a folder", path)
	}
	top, err := s.git(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil || top == "" {
		return localFolder{path: path}, nil
	}
	if _, err := s.git(ctx, top, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"); err != nil {
		return localFolder{path: path}, nil
	}
	branch, _ := s.git(ctx, top, "rev-parse", "--abbrev-ref", "HEAD")
	if branch == "HEAD" {
		branch = ""
	}
	return localFolder{path: top, git: true, branch: branch}, nil
}

// addCheckoutWorktree creates the workspace's worktree on a new branch in the
// checkout at repoPath: forked from the freshest copy of baseBranch when one is
// named, else from the checkout's current commit — as Claude Code does.
func (s *Service) addCheckoutWorktree(ctx context.Context, repoPath, worktree, branch, baseBranch string) error {
	s.refreshBase(ctx, repoPath, baseBranch)
	base, err := s.resolveBase(ctx, repoPath, baseBranch)
	if err != nil {
		return err
	}
	if _, err := s.git(ctx, repoPath, "worktree", "add", "-b", branch, worktree, base); err != nil {
		return fmt.Errorf("worktree add: %w", err)
	}
	return nil
}

// refreshBase fetches the base branch so a session starts from what is on the
// remote, not whatever the user last pulled. Offline, or without credentials
// the agent can use, it quietly keeps what the checkout already has.
func (s *Service) refreshBase(ctx context.Context, repoPath, baseBranch string) {
	if baseBranch == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	_, _ = s.git(ctx, repoPath, "fetch", "--quiet", "origin", baseBranch)
}

// resolveBase picks the commit to fork from: the remote branch when there is
// one, else a local branch of that name, else whatever is checked out. The last
// two cover a clone whose remote is not called origin, or one never pushed.
func (s *Service) resolveBase(ctx context.Context, repoPath, baseBranch string) (string, error) {
	candidates := []string{"HEAD"}
	if baseBranch != "" {
		candidates = []string{"origin/" + baseBranch, baseBranch, "HEAD"}
	}
	for _, ref := range candidates {
		if _, err := s.git(ctx, repoPath, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err == nil {
			return ref, nil
		}
	}
	return "", fmt.Errorf("%s has no commit to branch from", repoPath)
}

// worktreeRepo is the repository a worktree belongs to: the bare mirror on a
// Runtime Computer, the user's own clone for a local session. It is asked of
// git rather than remembered, so Destroy still works after an agent restart.
func (s *Service) worktreeRepo(ctx context.Context, worktree string) string {
	dir, err := s.git(ctx, worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil || dir == "" {
		return s.mirrorPath()
	}
	return dir
}

// git runs one git command in dir with the session environment, which holds no
// agent control secrets. Git never prompts: there is no terminal to answer it,
// so a credential request fails fast instead of hanging the request.
func (s *Service) git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := s.gitRaw(ctx, dir, args...)
	return strings.TrimSpace(out), err
}

// gitRaw is git without trimming, for output whose leading spaces carry meaning
// (`status --porcelain` codes).
func (s *Service) gitRaw(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(append([]string(nil), s.env...), "GIT_TERMINAL_PROMPT=0")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()+stdout.String()))
	}
	return stdout.String(), nil
}

package localimport

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// checkouts inspects the git checkouts sessions ran in, each folder once
// however many sessions ran there.
type checkouts struct {
	mu    sync.Mutex
	repos map[string]*repoLookup
}

type repoLookup struct {
	once sync.Once
	info repoInfo
}

// repoInfo is what a folder's checkout is.
type repoInfo struct {
	// Top is the checkout's top folder.
	Top string
	// Repo is its GitHub repository, "owner/name".
	Repo string
	// Current is the branch checked out ("" when detached).
	Current string
	// DefaultBranch is the remote's default branch, as last fetched.
	DefaultBranch string
	Skip          *Skip
}

func newCheckouts() *checkouts { return &checkouts{repos: map[string]*repoLookup{}} }

// inspect completes a session from its checkout, or says why it can't be
// imported.
func (c *checkouts) inspect(ctx context.Context, s *Session) {
	if info, err := os.Stat(s.Cwd); err != nil || !info.IsDir() {
		s.Skip = &Skip{Reason: SkipWorktreeMissing, Detail: s.Cwd + " is gone"}
		return
	}
	info := c.repo(ctx, s.Cwd)
	if info.Skip != nil {
		s.Skip = info.Skip
		return
	}
	s.Worktree, s.Repo = info.Top, info.Repo
	if s.Branch == "" {
		s.Branch = info.Current
	}
	if s.Branch == "" {
		s.Skip = &Skip{Reason: SkipBranchMissing, Detail: "the session was not on a branch"}
		return
	}
	if _, err := git(ctx, info.Top, "rev-parse", "--verify", "--quiet", "refs/heads/"+s.Branch); err != nil {
		s.Skip = &Skip{Reason: SkipBranchMissing, Detail: "branch " + s.Branch + " is no longer in " + info.Top}
		return
	}
	if s.BaseBranch == "" {
		s.BaseBranch = info.DefaultBranch
	}
	s.CheckedOut = info.Current == s.Branch
	if s.CheckedOut {
		status, _ := git(ctx, info.Top, "status", "--porcelain")
		s.Dirty = status != ""
	}
	if count, err := git(ctx, info.Top, "rev-list", "--count", "refs/heads/"+s.Branch, "--not", "--remotes"); err == nil {
		s.Unpushed, _ = strconv.Atoi(count)
	}
}

// repo inspects the checkout a folder is in, once.
func (c *checkouts) repo(ctx context.Context, dir string) repoInfo {
	c.mu.Lock()
	lookup, ok := c.repos[dir]
	if !ok {
		lookup = &repoLookup{}
		c.repos[dir] = lookup
	}
	c.mu.Unlock()
	lookup.once.Do(func() { lookup.info = inspectRepo(ctx, dir) })
	return lookup.info
}

func inspectRepo(ctx context.Context, dir string) repoInfo {
	top, err := git(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return repoInfo{Skip: &Skip{Reason: SkipNoGitHubRemote, Detail: dir + " is not a git repository"}}
	}
	repo, remote := githubRepo(ctx, top)
	if repo == "" {
		detail := "no remote is on GitHub"
		if remote != "" {
			detail = "origin is " + remote + ", not GitHub"
		}
		return repoInfo{Skip: &Skip{Reason: SkipNoGitHubRemote, Detail: detail}}
	}
	current, _ := git(ctx, top, "symbolic-ref", "--quiet", "--short", "HEAD")
	base := "main"
	if head, err := git(ctx, top, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		base = strings.TrimPrefix(head, "origin/")
	}
	return repoInfo{Top: top, Repo: repo, Current: current, DefaultBranch: base}
}

// githubRemote matches a GitHub remote URL in each form git takes one.
var githubRemote = regexp.MustCompile(
	`^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com(?::22)?/)` +
		`([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/([A-Za-z0-9._-]+?)(?:\.git)?/?$`)

// parseGitHubRemote is a remote URL's "owner/name", or "" when it is not GitHub.
func parseGitHubRemote(url string) string {
	m := githubRemote.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil || m[2] == "." || m[2] == ".." {
		return ""
	}
	return m[1] + "/" + m[2]
}

// githubRepo is the checkout's GitHub repository: origin's, else the first
// remote on GitHub. remote is origin's URL, for saying why there is none.
func githubRepo(ctx context.Context, top string) (repo, remote string) {
	origin, _ := git(ctx, top, "remote", "get-url", "origin")
	if repo := parseGitHubRemote(origin); repo != "" {
		return repo, origin
	}
	names, _ := git(ctx, top, "remote")
	for _, name := range strings.Fields(names) {
		url, _ := git(ctx, top, "remote", "get-url", name)
		if repo := parseGitHubRemote(url); repo != "" {
			return repo, url
		}
	}
	return "", origin
}

// git runs a read-only git command in dir and returns its trimmed output.
// GIT_OPTIONAL_LOCKS=0 keeps `status` from refreshing the index of a
// checkout someone may be working in.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

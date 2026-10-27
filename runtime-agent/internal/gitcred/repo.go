package gitcred

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// ErrInvalidRepo is a repository that isn't "owner/name".
var ErrInvalidRepo = errors.New("invalid repository: want owner/name")

// repoPattern is GitHub's own: owner and repository names are made of these.
var repoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// NormalizeRepo is repo as the control plane is asked for it: "owner/name",
// without a leading slash or a trailing ".git" (as git's credential request
// gives it), or "" for the box's own project.
func NormalizeRepo(repo string) (string, error) {
	repo = strings.TrimSuffix(strings.Trim(strings.TrimSpace(repo), "/"), ".git")
	if repo == "" {
		return "", nil
	}
	owner, name, _ := strings.Cut(repo, "/")
	if !repoPattern.MatchString(repo) || strings.Trim(owner, ".") == "" || strings.Trim(name, ".") == "" {
		return "", ErrInvalidRepo
	}
	return repo, nil
}

// repoKey is the cache's key for a normalized repository: GitHub's names
// are case-insensitive, so Owner/Name and owner/name share a token.
func repoKey(repo string) string { return strings.ToLower(repo) }

// RepoFromRemote is the "owner/name" of a github.com remote URL, in any of
// the forms git takes: https://github.com/owner/name(.git),
// git@github.com:owner/name(.git) or ssh://git@github.com/owner/name(.git).
// ok is false for another host or a URL that names no repository.
func RepoFromRemote(remote string) (repo string, ok bool) {
	remote = strings.TrimSpace(remote)
	var host, path string
	if strings.Contains(remote, "://") {
		u, err := url.Parse(remote)
		if err != nil {
			return "", false
		}
		host, path = u.Hostname(), u.Path
	} else {
		// The scp-like form, [user@]host:path.
		hostPart, pathPart, found := strings.Cut(remote, ":")
		if !found {
			return "", false
		}
		if _, after, at := strings.Cut(hostPart, "@"); at {
			hostPart = after
		}
		host, path = hostPart, pathPart
	}
	if !strings.EqualFold(host, "github.com") {
		return "", false
	}
	return firstTwo(path)
}

// firstTwo is the owner/name a github.com path starts with.
func firstTwo(path string) (string, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 {
		return "", false
	}
	repo, err := NormalizeRepo(parts[0] + "/" + parts[1])
	return repo, err == nil && repo != ""
}

// RepoFromGhArgs is the repository a gh command line names with -R or
// --repo, as gh takes it: OWNER/REPO, HOST/OWNER/REPO or a URL. ok is false
// when it names none, or one on another host than github.com.
func RepoFromGhArgs(args []string) (repo string, ok bool) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		var value string
		switch {
		case arg == "--":
			return "", false // what follows is the command's, not gh's
		case arg == "-R" || arg == "--repo":
			if i+1 >= len(args) {
				return "", false
			}
			value = args[i+1]
		case strings.HasPrefix(arg, "--repo="):
			value = strings.TrimPrefix(arg, "--repo=")
		case strings.HasPrefix(arg, "-R"):
			value = strings.TrimPrefix(strings.TrimPrefix(arg, "-R"), "=")
		default:
			continue
		}
		return ghRepo(value)
	}
	return "", false
}

// ghRepo reads a repository as gh's -R and $GH_REPO take it.
func ghRepo(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if strings.Contains(value, "://") || strings.HasPrefix(value, "git@") {
		return RepoFromRemote(value)
	}
	parts := strings.Split(strings.Trim(value, "/"), "/")
	switch len(parts) {
	case 2:
		return firstTwo(value)
	case 3:
		if !strings.EqualFold(parts[0], "github.com") {
			return "", false
		}
		return firstTwo(parts[1] + "/" + parts[2])
	}
	return "", false
}

package gitcred

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// Helper is git's credential helper for github.com (`runtime-agent
// git-credential --root R <op>`): for a get it answers with the agent's token
// for the repository git names (its path, with useHttpPath), and for an
// erase it has the agent forget it. Anything else (store) needs nothing.
//
// fallback is the token the box was launched with ($GH_TOKEN), answered when
// the agent can't give one, but not when Outrunner refused (RefusedError):
// a user who chose the App isn't quietly pushed as themselves. Otherwise git
// hears nothing and fails as it would with no helper, the reason on errOut.
// A helper's exit status doesn't change that, so it is always 0.
func Helper(ctx context.Context, op string, in io.Reader, out, errOut io.Writer, local Local, fallback string) int {
	if op != "get" && op != "erase" {
		return 0
	}
	attrs := readCredentialRequest(in)
	isGitLab := strings.EqualFold(attrs["host"], "gitlab.com")
	if attrs["protocol"] != "https" || (!isGitLab && !strings.EqualFold(attrs["host"], "github.com")) {
		return 0
	}
	repo, _ := firstTwo(attrs["path"])
	if isGitLab {
		var err error
		repo, err = NormalizeRepo("gitlab.com/" + attrs["path"])
		if err != nil {
			return 0
		}
		// GH_TOKEN is never a fallback for GitLab, including an outage.
		fallback = ""
	}
	if op == "erase" {
		_ = local.Erase(ctx, repo)
		return 0
	}
	token, err := local.Token(ctx, repo)
	if err != nil {
		if fallback == "" || refused(err) {
			fmt.Fprintf(errOut, "outrunner: no Git credential for %s: %v\n", describeRepo(repo), err)
			return 0
		}
		token = fallback
	}
	fmt.Fprintf(out, "username=x-access-token\npassword=%s\n", token)
	return 0
}

// readCredentialRequest reads git's key=value lines, up to a blank line or
// the end.
func readCredentialRequest(in io.Reader) map[string]string {
	attrs := map[string]string{}
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			break
		}
		if key, value, ok := strings.Cut(line, "="); ok {
			attrs[key] = value
		}
	}
	return attrs
}

// GitHubToken prints a token for the repository a gh command works on, for
// the gh wrapper to run it with as $GH_TOKEN (`runtime-agent github-token
// --root R -- <gh args>`). The repository is the one gh would pick: its -R,
// else $GH_REPO, else the origin of the git repository it runs in; with none
// of them, the box's own project. When the agent can't give one, the token
// the box was launched with is printed instead, unless Outrunner refused;
// with neither it fails, and gh runs on its own login.
func GitHubToken(ctx context.Context, ghArgs []string, out, errOut io.Writer, local Local, getenv func(string) string, origin func() string) int {
	repo := DetectRepo(ghArgs, getenv("GH_REPO"), origin)
	token, err := local.Token(ctx, repo)
	if err != nil {
		token = getenv("GH_TOKEN")
		if refused(err) {
			token = ""
		}
		if token == "" {
			fmt.Fprintf(errOut, "outrunner: no GitHub token for %s: %v\n", describeRepo(repo), err)
			return 1
		}
	}
	fmt.Fprintln(out, token)
	return 0
}

// DetectRepo is the repository a gh command works on, in gh's own order;
// "" when nothing names one. origin is only asked when it's needed.
func DetectRepo(ghArgs []string, ghRepoEnv string, origin func() string) string {
	if repo, ok := RepoFromGhArgs(ghArgs); ok {
		return repo
	}
	if ghRepoEnv != "" {
		if repo, ok := ghRepo(ghRepoEnv); ok {
			return repo
		}
	}
	if origin != nil {
		if repo, ok := RepoFromRemote(origin()); ok {
			return repo
		}
	}
	return ""
}

// OriginURL is the origin remote of the git repository in the working
// directory, or "" outside one.
func OriginURL() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func describeRepo(repo string) string {
	if repo == "" {
		return "this project"
	}
	return repo
}

// refused reports whether err is Outrunner saying no on purpose.
func refused(err error) bool {
	var refusal *RefusedError
	return errors.As(err, &refusal)
}

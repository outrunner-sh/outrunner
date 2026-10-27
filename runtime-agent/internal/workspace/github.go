package workspace

import (
	"path/filepath"
	"strconv"
	"strings"

	"runtime-agent/internal/claude"
)

// A session's own GitHub token, in place of the box's.
//
// The box's GH_TOKEN is its user's own (the agent's environment), for `gh` and
// for git, which is pointed at it for github.com (githubCredentialEnv). A
// session the server starts on its own (an automation's review) brings a token
// of its own instead: the Outrunner GitHub App's, for the one repository, which
// can comment and can't push. It's kept in the session's file here, owner-only
// (keyFiles), and its launch sources it innermost (withGitHub), on the command
// line rather than in tmux's environment, which a running tmux server doesn't
// take from a new session (see codexLaunchEnv). Innermost, it wins over a
// GH_TOKEN in the project's environment or the session's provided secrets too.
//
// A session that was given one never falls back to the box's: without its
// file (gone with a restore) it runs with no GitHub token at all, rather than
// as its user. The token's lifetime (an hour, for the app's) is its caller's
// to mind: a fresh one comes with a repeated create.

const githubTokenEnv = "GH_TOKEN"

func (s *Service) githubFiles() keyFiles {
	return keyFiles{dir: filepath.Join(s.Root, "github"), envs: []string{githubTokenEnv}}
}

// githubEnvFile is a session's own token, and git pointed at it alone for
// github.com, as the shell file its launch sources (on a box with no GH_TOKEN
// of its own, git has no helper to use it otherwise). `gh` is kept off any
// other credential (noLogin), and git too (sessionGitConfig).
func githubEnvFile(token, noLoginDir string) string {
	var b strings.Builder
	b.WriteString("export " + githubTokenEnv + "=" + claude.ShellQuote(token) + "\n")
	b.WriteString("unset GITHUB_TOKEN SSH_AUTH_SOCK\n")
	b.WriteString("export GH_CONFIG_DIR=" + claude.ShellQuote(noLoginDir) + "\n")
	for _, entry := range sessionGitConfig(true) {
		name, value, _ := strings.Cut(entry, "=")
		b.WriteString("export " + name + "=" + claude.ShellQuote(value) + "\n")
	}
	return b.String()
}

// sessionGitConfig is the git config (GIT_CONFIG_*) of a session on a GitHub
// token of its own, its helper among it with `helper`; without, none:
//
//   - an empty github.com helper first: git's helpers add up, so one in the
//     user's ~/.gitconfig (`store`, a keychain) would be asked before ours
//     and answer as the user. The empty one resets the list.
//   - no SSH, for any host: an `insteadOf` in the user's gitconfig, or an SSH
//     remote, would push with the box's SSH key, as the user, past every
//     helper. Such a session talks to its repository over https.
//
// It replaces any GIT_CONFIG_* the project's environment or provided secrets
// set: in this session, git's own config is what keeps it off the user's.
//
// This keeps git and gh off the user's credentials by accident, not against
// an agent set on reaching them: ~/.ssh is still on the box, and `git -c`
// overrides any of this. Dropping SSH_AUTH_SOCK takes away the easy way to a
// key; the app token itself is what can't push, whatever git is told.
func sessionGitConfig(helper bool) []string {
	entries := [][2]string{{githubHelperName, ""}}
	if helper {
		entries = append(entries, [2]string{githubHelperName, githubHelperScript})
	}
	entries = append(entries, [2]string{"protocol.ssh.allow", "never"})
	env := []string{"GIT_CONFIG_COUNT=" + strconv.Itoa(len(entries))}
	for i, e := range entries {
		n := strconv.Itoa(i)
		env = append(env, "GIT_CONFIG_KEY_"+n+"="+e[0], "GIT_CONFIG_VALUE_"+n+"="+e[1])
	}
	return env
}

// noGitHubCredentials is a session with no GitHub token of its own left:
// none of the box's or its user's, for gh or for git.
func (s *Service) noGitHubCredentials() []string {
	env := []string{"env", "-u", githubTokenEnv, "-u", "GITHUB_TOKEN", "-u", "SSH_AUTH_SOCK", "GH_CONFIG_DIR=" + s.noGitHubLoginDir()}
	return append(env, sessionGitConfig(false)...)
}

// setSessionGitHubToken keeps the session's own token; a new one replaces it
// (the one it replaces stays masked, retired).
func (s *Service) setSessionGitHubToken(workspaceID, token string) error {
	if err := s.githubFiles().put(workspaceID, githubEnvFile(token, s.noGitHubLoginDir())); err != nil {
		return err
	}
	// Masked at once in the terminals and recordings already open.
	s.liveSecrets.Add(token)
	return nil
}

// ownsGitHub reports whether a session was given its own token: by its facts,
// or by its file, should the facts have been lost.
func (s *Service) ownsGitHub(workspaceID string) bool {
	if facts, _ := s.getFacts(workspaceID); facts.OwnGitHub {
		return true
	}
	return fileExists(s.githubFiles().path(workspaceID))
}

// noGitHubLoginDir is an empty `gh` config folder (GH_CONFIG_DIR): a session
// on its own token, or on none, never reaches a login stored on the box
// (`gh auth login`'s hosts.yml), which would be its user's.
func (s *Service) noGitHubLoginDir() string {
	return filepath.Join(s.githubFiles().dir, "no-login")
}

// withGitHub has a session with its own token launch on it: sourcing its file,
// or, with the file gone, with no GitHub credential at all (the box's GH_TOKEN
// and GITHUB_TOKEN dropped, no stored login). Any other session's argv is left
// as it is.
func (s *Service) withGitHub(workspaceID string, argv []string) []string {
	if !s.ownsGitHub(workspaceID) {
		return argv
	}
	path := s.githubFiles().path(workspaceID)
	if !fileExists(path) {
		return append(s.noGitHubCredentials(), argv...)
	}
	return claude.WithEnvFile(argv, path)
}

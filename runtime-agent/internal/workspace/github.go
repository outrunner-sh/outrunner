package workspace

import (
	"path/filepath"
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
// other credential (noLogin), and git too: its helpers add up, so one in the
// user's ~/.gitconfig (`store`, a keychain) would be asked first and answer
// as the user. An empty helper ahead of ours resets the list.
func githubEnvFile(token, noLoginDir string) string {
	var b strings.Builder
	b.WriteString("export " + githubTokenEnv + "=" + claude.ShellQuote(token) + "\n")
	b.WriteString("unset GITHUB_TOKEN\n")
	b.WriteString("export GH_CONFIG_DIR=" + claude.ShellQuote(noLoginDir) + "\n")
	_, helper, _ := strings.Cut(githubCredentialEnv[2], "=") // GIT_CONFIG_VALUE_0
	for _, entry := range []string{
		"GIT_CONFIG_COUNT=2",
		githubHelperKey + "0=" + githubHelperName, "GIT_CONFIG_VALUE_0=",
		githubHelperKey + "1=" + githubHelperName, "GIT_CONFIG_VALUE_1=" + helper,
	} {
		name, value, _ := strings.Cut(entry, "=")
		b.WriteString("export " + name + "=" + claude.ShellQuote(value) + "\n")
	}
	return b.String()
}

const (
	githubHelperKey  = "GIT_CONFIG_KEY_"
	githubHelperName = "credential.https://github.com.helper"
)

// noGitHubCredentials is a session with no GitHub token of its own left:
// none of the box's or its user's, for gh or for git.
func (s *Service) noGitHubCredentials() []string {
	return []string{
		"env", "-u", githubTokenEnv, "-u", "GITHUB_TOKEN", "GH_CONFIG_DIR=" + s.noGitHubLoginDir(),
		"GIT_CONFIG_COUNT=1", githubHelperKey + "0=" + githubHelperName, "GIT_CONFIG_VALUE_0=",
	}
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

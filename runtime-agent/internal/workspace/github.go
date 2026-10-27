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

// githubEnvFile is a session's own token, and git pointed at it for
// github.com, as the shell file its launch sources: on a box with no GH_TOKEN
// of its own, git has no helper to use it otherwise.
func githubEnvFile(token string) string {
	var b strings.Builder
	b.WriteString("export " + githubTokenEnv + "=" + claude.ShellQuote(token) + "\n")
	for _, entry := range githubCredentialEnv {
		name, value, _ := strings.Cut(entry, "=")
		b.WriteString("export " + name + "=" + claude.ShellQuote(value) + "\n")
	}
	return b.String()
}

// setSessionGitHubToken keeps the session's own token; a new one replaces it
// (the one it replaces stays masked, retired).
func (s *Service) setSessionGitHubToken(workspaceID, token string) error {
	if err := s.githubFiles().put(workspaceID, githubEnvFile(token)); err != nil {
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

// withGitHub has a session with its own token launch on it: sourcing its file,
// or, with the file gone, with the box's GH_TOKEN dropped. Any other session's
// argv is left as it is.
func (s *Service) withGitHub(workspaceID string, argv []string) []string {
	if !s.ownsGitHub(workspaceID) {
		return argv
	}
	path := s.githubFiles().path(workspaceID)
	if !fileExists(path) {
		return append([]string{"env", "-u", githubTokenEnv}, argv...)
	}
	return claude.WithEnvFile(argv, path)
}

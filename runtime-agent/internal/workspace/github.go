package workspace

import (
	"path/filepath"

	"runtime-agent/internal/claude"
)

// A session's own GitHub token, in place of the box's.
//
// The box's GH_TOKEN is its user's own (the agent's environment), for `gh` and
// for git, which is pointed at it for github.com (githubCredentialEnv). A
// session the server starts on its own (an automation's review) brings a token
// of its own instead: the Outrunner GitHub App's, for the one repository, which
// can comment and can't push. It's kept in the session's file here, owner-only
// (keyFiles), and its launch runs with it as GH_TOKEN. A session that was given
// one never falls back to the box's: without its file (gone with a restore) it
// runs with no GitHub token at all, rather than as its user.

const githubTokenEnv = "GH_TOKEN"

func (s *Service) githubFiles() keyFiles {
	return keyFiles{dir: filepath.Join(s.Root, "github"), envs: []string{githubTokenEnv}}
}

// setSessionGitHubToken keeps the session's own token; a new one replaces it
// (the one it replaces stays masked, retired).
func (s *Service) setSessionGitHubToken(workspaceID, token string) error {
	if err := s.githubFiles().put(workspaceID, "export "+githubTokenEnv+"="+claude.ShellQuote(token)+"\n"); err != nil {
		return err
	}
	// Masked at once in the terminals and recordings already open.
	s.liveSecrets.Add(token)
	return nil
}

// launchEnv is the environment a session's agent launches with: its agent's,
// with the session's own GitHub token in place of the box's when it has one.
func (s *Service) launchEnv(a agent, workspaceID, anthropicToken string) []string {
	env := a.env(anthropicToken)
	facts, _ := s.getFacts(workspaceID)
	if !facts.OwnGitHub {
		return env
	}
	env = withoutEnv(env, githubTokenEnv)
	if token := s.githubFiles().value(workspaceID, githubTokenEnv); token != "" {
		env = append(env, githubTokenEnv+"="+token)
	}
	return env
}

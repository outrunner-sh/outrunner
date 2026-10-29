package workspace

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/sessiontools"
)

// On a Runtime Computer the control plane can give the sessions GitHub
// tokens for as long as they run (package gitcred): GitHub App installation
// tokens last an hour, so git and gh ask this agent for one whenever they
// need it, rather than read one the box was launched with. Sessions get:
//
//   - git's credential helper for github.com as this binary (`runtime-agent
//     git-credential`), with useHttpPath, so it hears which repository;
//   - $ROOT/.outrunner/bin first on PATH, holding a gh that runs the real one
//     with a token for the repository it works on (`runtime-agent
//     github-token`).
//
// Both find the agent as the ask_user relay does (AskPaths), and prove they
// run on this box with the credential token, made at each start. The user's
// own token ($GH_TOKEN), when the box was launched with one, stays in the
// sessions' environment: both fall back to it when the agent can't answer.

// GitCredentialPaths are the files the helpers read: the agent's announced
// address and its credential token.
func GitCredentialPaths(root string) (addrFile, tokenFile string) {
	addrFile, _ = AskPaths(root, "")
	return addrFile, filepath.Join(root, "git-credential.token")
}

// gitBinDir holds the gh wrapper, first on the sessions' PATH.
func (s *Service) gitBinDir() string { return filepath.Join(s.Root, ".outrunner", "bin") }

// UseGitCredential has the sessions get their GitHub tokens through this
// agent from client's control plane. Called once at start, after
// RelayExecutable is known and before the environment is handed out
// (SessionEnv); the sessions are otherwise left as they were.
func (s *Service) UseGitCredential(client *gitcred.Client) error {
	if s.RelayExecutable == "" {
		return errors.New("no executable for git's credential helper")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	token := hex.EncodeToString(b)
	_, tokenFile := GitCredentialPaths(s.Root)
	if err := writeKeysFile(tokenFile, token+"\n"); err != nil {
		return err
	}
	s.gitToken = token
	s.gitTokens = gitcred.NewCache(client, s.refreshLiveSecrets)
	s.controlPlane = client
	if err := s.writeGhWrapper(); err != nil {
		// git still pushes; gh runs on the box's own token.
		log.Printf("runtime-agent: gh runs without fresh GitHub tokens: %v", err)
	}
	if err := s.writeSessionToolsWrapper(); err != nil {
		log.Printf("runtime-agent: sessions have no %s: %v", sessiontools.CommandName, err)
	}
	s.env = gitCredentialEnv(s.env, s.RelayExecutable, s.Root, s.gitBinDir())
	return nil
}

// writeGhWrapper puts the gh wrapper in gitBinDir when the box has gh, or
// removes one an earlier start left for a gh that's gone.
func (s *Service) writeGhWrapper() error {
	wrapper := filepath.Join(s.gitBinDir(), "gh")
	realGh, ok := gitcred.FindExecutable("gh", envValue(s.env, "PATH"), s.gitBinDir(), wrapper)
	if !ok {
		if err := os.Remove(wrapper); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(s.gitBinDir(), 0o755); err != nil {
		return err
	}
	tmp := wrapper + ".tmp"
	if err := os.WriteFile(tmp, []byte(gitcred.GhWrapper(s.RelayExecutable, s.Root, realGh)), 0o755); err != nil {
		return err
	}
	// WriteFile's mode is masked by the umask, and an earlier file keeps its
	// own: the wrapper must be executable either way.
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, wrapper); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// gitCredentialEnv is env with git's credential helper for github.com as
// executable's, in place of any git config the environment carried (the
// GitHub token's, githubCredentialEnv), and binDir first on PATH. An empty
// helper first clears any the box's own git config has for github.com (gh's
// `auth setup-git`, say), which git would otherwise ask before this one.
func gitCredentialEnv(env []string, executable, root, binDir string) []string {
	out := make([]string, 0, len(env)+5)
	path := ""
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		switch {
		case key == "GIT_CONFIG_COUNT", strings.HasPrefix(key, "GIT_CONFIG_KEY_"), strings.HasPrefix(key, "GIT_CONFIG_VALUE_"):
			continue
		case key == "PATH":
			// Without the wrapper's folder already there: an agent started
			// from a session inherits it.
			path = strings.Join(slices.DeleteFunc(filepath.SplitList(value), func(dir string) bool {
				return filepath.Clean(dir) == binDir
			}), string(os.PathListSeparator))
			continue
		}
		out = append(out, entry)
	}
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	return append(out,
		"PATH="+binDir+string(os.PathListSeparator)+path,
		"GIT_CONFIG_COUNT=3",
		"GIT_CONFIG_KEY_0=credential.https://github.com.helper",
		"GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=credential.https://github.com.helper",
		"GIT_CONFIG_VALUE_1="+gitcred.HelperCommand(executable, root),
		"GIT_CONFIG_KEY_2=credential.https://github.com.useHttpPath",
		"GIT_CONFIG_VALUE_2=true",
	)
}

// envValue is the value of name in env, or "".
func envValue(env []string, name string) string {
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, name+"="); ok {
			return value
		}
	}
	return ""
}

// GitCredentialEnabled reports whether the sessions get their GitHub tokens
// through this agent (UseGitCredential).
func (s *Service) GitCredentialEnabled() bool { return s.gitTokens != nil }

// GitCredentialAuthorized reports whether token is the agent's credential
// token: a call from a helper on this box.
func (s *Service) GitCredentialAuthorized(token string) bool {
	return s.gitToken != "" && subtle.ConstantTimeCompare([]byte(s.gitToken), []byte(token)) == 1
}

// GitCredential is a token for repo ("owner/name", or "" for the box's own
// project); gitcred.ErrInvalidRepo for a repo that names none.
func (s *Service) GitCredential(ctx context.Context, repo string) (gitcred.Credential, error) {
	if s.gitTokens == nil {
		return gitcred.Credential{}, errors.New("this computer gets no GitHub tokens from Outrunner")
	}
	return s.gitTokens.Get(ctx, repo)
}

// EraseGitCredential forgets the token for repo: git was refused it.
func (s *Service) EraseGitCredential(repo string) error {
	if s.gitTokens == nil {
		return nil
	}
	return s.gitTokens.Erase(repo)
}

// credentialTokens are the GitHub tokens the agent has handed out that may
// still work, masked in the terminals like any other credential.
func (s *Service) credentialTokens() []string {
	if s.gitTokens == nil {
		return nil
	}
	return s.gitTokens.Tokens()
}

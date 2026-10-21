package workspace

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"runtime-agent/internal/codex"
)

// A Codex session given an OpenAI API key runs in a Codex home of its own,
// $ROOT/codex/<id>, logged in with that key: Codex reads its login from its
// home (CODEX_HOME), not from the environment, and the user's own home on a
// Mac holds their ChatGPT login, which the session must neither use nor
// replace. A Codex session without a key runs in the user's own home.

// codexLoginTimeout bounds `codex login`, which only writes the home's
// auth.json: a hung one must not hold the session's lifecycle lock.
const codexLoginTimeout = 30 * time.Second

func (s *Service) codexHome(workspaceID string) string {
	return filepath.Join(s.Root, "codex", workspaceID)
}

// ownCodexHome reports whether a session runs in a Codex home of its own.
func (s *Service) ownCodexHome(workspaceID string) bool {
	f, _ := s.getFacts(workspaceID)
	return f.Auth == AuthOpenAIAPIKey
}

// prepareCodexHome readies a session's own Codex home for a launch: owner-
// only, its config keeping the login in the home's auth.json (not the
// system keychain, shared by every home) and trusting the session's folder
// (so no trust question waits for an answer), then logged in with the
// session's key, given on stdin, never on a command line.
func (s *Service) prepareCodexHome(ctx context.Context, workspaceID string) error {
	key := s.authFiles().value(workspaceID, "OPENAI_API_KEY")
	if key == "" {
		return ErrAuthMissing
	}
	home := s.codexHome(workspaceID)
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(home, 0o700); err != nil {
		return err
	}
	// Codex keys its trust by the folder's real path (/private/tmp, not /tmp).
	folder := s.worktreePath(workspaceID)
	if real, err := filepath.EvalSymlinks(folder); err == nil {
		folder = real
	}
	config := "cli_auth_credentials_store = \"file\"\n\n" +
		"[projects." + codex.TOMLString(folder) + "]\ntrust_level = \"trusted\"\n"
	// writeKeysFile: owner-only and atomic, so Codex never reads half of it.
	if err := writeKeysFile(filepath.Join(home, "config.toml"), config); err != nil {
		return err
	}
	copyAgentsMD(home) // the user's instructions, as the computer's own home has them
	ctx, cancel := context.WithTimeout(ctx, codexLoginTimeout)
	defer cancel()
	env := append(withoutEnv(s.env, "CODEX_HOME", "OPENAI_API_KEY"), "CODEX_HOME="+home)
	if out, err := s.runCommand(ctx, env, key+"\n", "codex", "login", "--with-api-key"); err != nil {
		msg := strings.ReplaceAll(strings.TrimSpace(string(out)), key, "[key]")
		return fmt.Errorf("codex login: %v: %s", err, msg)
	}
	return nil
}

// codexLaunchEnv is the argv prefix that points a session's Codex at its own
// home. It rides the command line, not tmux's environment, which a running
// tmux server doesn't take from a new session's client. The home's path is no
// secret; an OPENAI_API_KEY in the agent's environment is dropped, so the
// session runs on its own key rather than the computer's.
func (s *Service) codexLaunchEnv(workspaceID string) []string {
	if !s.ownCodexHome(workspaceID) {
		return nil
	}
	return []string{"env", "-u", "OPENAI_API_KEY", "CODEX_HOME=" + s.codexHome(workspaceID)}
}

// withoutEnv is env without the named variables.
func withoutEnv(env []string, names ...string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if name, _, _ := strings.Cut(entry, "="); !slices.Contains(names, name) {
			out = append(out, entry)
		}
	}
	return out
}

// runCommand runs a helper to completion with env and stdin, returning what it
// printed: the default Service.runCommand.
func runCommand(ctx context.Context, env []string, stdin string, argv ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Stdin = strings.NewReader(stdin)
	return cmd.CombinedOutput()
}

package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/codex"
)

// A Codex session given an OpenAI API key or Codex workspace access token runs
// in a Codex home of its own, $ROOT/codex/<id>, logged in with that credential:
// Codex reads its login from its
// home (CODEX_HOME), not from the environment, and the user's own home on a
// Mac holds their ChatGPT login, which the session must neither use nor
// replace. So does one on a gateway (Outrunner's models through OpenRouter):
// its home's config puts Codex on the gateway, with the key, and the user's
// own config must not. A Codex session with neither runs in the user's own
// home.

// codexLoginTimeout bounds `codex login`, which only writes the home's
// auth.json: a hung one must not hold the session's lifecycle lock.
const codexLoginTimeout = 30 * time.Second

func (s *Service) codexHome(workspaceID string) string {
	return filepath.Join(s.Root, "codex", workspaceID)
}

// ownCodexHome reports whether a session runs in a Codex home of its own.
func (s *Service) ownCodexHome(workspaceID string) bool {
	f, _ := s.getFacts(workspaceID)
	return f.Auth == AuthOpenAIAPIKey || f.Auth == AuthCodexAccessToken || f.Auth == AuthCodexAccount || f.Gateway != claude.NoGateway
}

// prepareCodexHome readies a session's own Codex home for a launch: owner-
// only, its config keeping the login in the home's auth.json (not the
// system keychain, shared by every home), trusting the session's folder (so
// no trust question waits for an answer), with the computer's MCP servers
// (codex.MCPServersConfig) and, on a gateway, putting Codex on it with the
// session's gateway key (codex.ProviderConfig). With an OpenAI
// key or Codex workspace token, it is then logged in with it, given on stdin,
// never on a command line.
// Rewritten each launch from the session's facts, so a model switched to or
// from a gateway, or a key replaced, is what the next launch runs on.
func (s *Service) prepareCodexHome(ctx context.Context, workspaceID string) error {
	f, _ := s.getFacts(workspaceID)
	credentialEnv, loginFlag := "OPENAI_API_KEY", "--with-api-key"
	if f.Auth == AuthCodexAccessToken {
		credentialEnv, loginFlag = "CODEX_ACCESS_TOKEN", "--with-access-token"
	}
	if f.Auth == AuthCodexAccount {
		credentialEnv = "OUTRUNNER_CODEX_GRANT"
	}
	key := s.authFiles().value(workspaceID, credentialEnv)
	if (f.Auth == AuthOpenAIAPIKey || f.Auth == AuthCodexAccessToken || f.Auth == AuthCodexAccount) && key == "" {
		return ErrAuthMissing
	}
	provider := ""
	if f.Gateway != claude.NoGateway {
		token := s.gatewayFiles().value(workspaceID, codexGatewayKeyEnv)
		if token == "" {
			return ErrGatewayKeyMissing
		}
		if provider = codex.ProviderConfig(f.Gateway, token); provider == "" {
			return ErrGatewayUnsupported
		}
	}
	accountAuth := ""
	if f.Auth == AuthCodexAccount && f.Gateway == claude.NoGateway {
		var err error
		provider, accountAuth, err = codex.AccountConfig(key)
		if err != nil {
			return err
		}
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
	// The provider's top-level key goes before the tables.
	config := "cli_auth_credentials_store = \"file\"\n" + provider + "\n" +
		"[projects." + codex.TOMLString(folder) + "]\ntrust_level = \"trusted\"\n" +
		// The MCP servers a Claude launch is given (agentconfig.go): the
		// user's own, their project's and Outrunner's, for Codex too.
		codex.MCPServersConfig(agentMCPServers(), s.codexEnvironment(workspaceID))
	// writeKeysFile: owner-only and atomic, so Codex never reads half of it.
	if err := writeKeysFile(filepath.Join(home, "config.toml"), config); err != nil {
		return err
	}
	if accountAuth != "" {
		if err := writeKeysFile(filepath.Join(home, "auth.json"), accountAuth); err != nil {
			return err
		}
	}
	copyAgentsMD(home) // the user's instructions, as the computer's own home has them
	if f.Auth != AuthOpenAIAPIKey && f.Auth != AuthCodexAccessToken {
		return nil // gateway or host-managed account: no provider login on the computer
	}
	ctx, cancel := context.WithTimeout(ctx, codexLoginTimeout)
	defer cancel()
	env := append(withoutEnv(s.env, "CODEX_HOME", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OUTRUNNER_CODEX_GRANT"), "CODEX_HOME="+home)
	if out, err := s.runCommand(ctx, env, key+"\n", "codex", "login", loginFlag); err != nil {
		if f.Auth == AuthCodexAccessToken {
			// An access-token login can exchange credentials. Do not forward
			// its output, which could include a derived credential as well as
			// the input token. Neither belongs in control-plane logs or UI.
			return fmt.Errorf("codex workspace access-token login failed: %w", err)
		}
		msg := strings.ReplaceAll(strings.TrimSpace(string(out)), key, "[key]")
		return fmt.Errorf("codex login: %v: %s", err, msg)
	}
	return nil
}

// codexEnvironment is what a session's Codex runs with, for the ${VAR}s of
// its MCP servers (codex.MCPServersConfig), in the order its launch makes
// it: the agent's own environment, less OpenAI credentials and with its Codex
// home (codexLaunchEnv); the project's variables, which its launch sources
// (withEnvironment); then what the user provided in the session, which wins
// (withProvided).
func (s *Service) codexEnvironment(workspaceID string) func(string) (string, bool) {
	env := map[string]string{}
	for _, entry := range withoutEnv(s.env, "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OUTRUNNER_CODEX_GRANT", "CODEX_HOME") {
		if name, value, ok := strings.Cut(entry, "="); ok {
			env[name] = value
		}
	}
	env["CODEX_HOME"] = s.codexHome(workspaceID)
	for _, line := range strings.Split(s.envFiles().read(workspaceID), "\n") {
		if name, quoted, ok := strings.Cut(strings.TrimPrefix(line, "export "), "="); ok && strings.HasPrefix(line, "export ") {
			env[name] = shellUnquote(quoted)
		}
	}
	provided := map[string]string{}
	if data, err := os.ReadFile(s.providedJSONPath(workspaceID)); err == nil && json.Unmarshal(data, &provided) == nil {
		for name, value := range provided {
			env[name] = value
		}
	}
	return func(name string) (string, bool) {
		value, ok := env[name]
		return value, ok
	}
}

// shellUnquote reads a value back as claude.ShellQuote wrote it: quoted
// runs, and the \' between them that stands for a quote.
func shellUnquote(quoted string) string {
	var b strings.Builder
	for len(quoted) > 0 {
		switch {
		case strings.HasPrefix(quoted, `\'`):
			b.WriteByte('\'')
			quoted = quoted[2:]
		case quoted[0] == '\'':
			end := strings.IndexByte(quoted[1:], '\'')
			if end < 0 {
				b.WriteString(quoted[1:])
				return b.String()
			}
			b.WriteString(quoted[1 : end+1])
			quoted = quoted[end+2:]
		default:
			b.WriteByte(quoted[0])
			quoted = quoted[1:]
		}
	}
	return b.String()
}

// codexLaunchEnv is the argv prefix that points a session's Codex at its own
// home. It rides the command line, not tmux's environment, which a running
// tmux server doesn't take from a new session's client. The home's path is no
// secret; OpenAI credentials in the agent's environment are dropped, so the
// session runs on its own key, or its gateway's, rather than the computer's.
func (s *Service) codexLaunchEnv(workspaceID string) []string {
	if !s.ownCodexHome(workspaceID) {
		return nil
	}
	return []string{"env", "-u", "OPENAI_API_KEY", "-u", "CODEX_ACCESS_TOKEN", "-u", "OUTRUNNER_CODEX_GRANT", "CODEX_HOME=" + s.codexHome(workspaceID)}
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

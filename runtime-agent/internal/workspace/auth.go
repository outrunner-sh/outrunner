package workspace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"

	"runtime-agent/internal/claude"
)

// A session's own credential — a Claude login token, an Anthropic or OpenAI
// API key, or a Codex workspace token — rather than whatever its agent is
// logged in with on the computer.
// It is kept like a gateway key (keyFiles): owner-only under $ROOT/auth, and
// applied at the session's next launch. A Claude session sources it; a Codex
// session logs its own Codex home in with it (codex_auth.go).

// The kinds of credential a session can be given (protocol.SetAuthRequest).
const (
	// AuthNone removes the session's credential: its agent's own login, or
	// the agent's environment, applies again.
	AuthNone             = "none"
	AuthClaudeOAuthToken = "claude-oauth-token"
	AuthAnthropicAPIKey  = "anthropic-api-key"
	AuthOpenAIAPIKey     = "openai-api-key"
	AuthCodexAccessToken = "codex-access-token"
	AuthCodexAccount     = "codex-account"
	AuthClaudeAccount    = "claude-account"
)

// authAgent is the agent each kind of credential is for.
var authAgent = map[string]string{
	AuthClaudeOAuthToken: AgentClaude,
	AuthClaudeAccount:    AgentClaude,
	AuthAnthropicAPIKey:  AgentClaude,
	AuthOpenAIAPIKey:     AgentCodex,
	AuthCodexAccessToken: AgentCodex,
	AuthCodexAccount:     AgentCodex,
}

// ValidAuthKind accepts a kind of credential a session can be given.
func ValidAuthKind(kind string) bool {
	return kind == AuthNone || authAgent[kind] != ""
}

var (
	// ErrAuthMismatch is a credential for another agent than the session
	// runs: an OpenAI key means nothing to Claude, nor a Claude token to Codex.
	ErrAuthMismatch = errors.New("this credential is for another agent than the one this session runs")
	// ErrAuthMissing is a session recorded with a credential whose file is
	// gone: launched anyway, it would run on whatever login the computer has.
	ErrAuthMissing = errors.New("this session's credential is missing; set it again to start the session")
)

// authKeyEnvs are the variables a session's credential is exported in.
var authKeyEnvs = []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OUTRUNNER_CODEX_GRANT", "OUTRUNNER_CLAUDE_GRANT"}

// ValidAuthToken keeps API-key bounds unchanged, while accepting the longer
// opaque credentials issued for Codex workspace automation. Both go into a
// shell-sourced file, so whitespace, quotes and backslashes remain forbidden.
func ValidAuthToken(kind, token string) bool {
	if kind == AuthClaudeAccount {
		_, err := claudeAccountEnv(token)
		return err == nil
	}
	if kind != AuthCodexAccessToken && kind != AuthCodexAccount {
		return claude.ValidGatewayToken(token)
	}
	if len(token) < 20 || len(token) > 16384 {
		return false
	}
	for _, r := range token {
		if r <= ' ' || r > '~' || r == '\'' || r == '\\' {
			return false
		}
	}
	return true
}

func (s *Service) authFiles() keyFiles {
	return keyFiles{dir: filepath.Join(s.Root, "auth"), envs: authKeyEnvs}
}

// authEnvFile renders a credential as the shell file its launch sources. Each
// Claude credential unsets the other, which would otherwise compete with it
// (an API key in the environment wins over a login token).
func authEnvFile(kind, token string) string {
	quoted := claude.ShellQuote(token)
	switch kind {
	case AuthClaudeAccount:
		env, _ := claudeAccountEnv(token)
		return env
	case AuthClaudeOAuthToken:
		return "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN OUTRUNNER_CLAUDE_GRANT\nunset ANTHROPIC_API_KEY\nexport CLAUDE_CODE_OAUTH_TOKEN=" + quoted + "\n"
	case AuthAnthropicAPIKey:
		return "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN OUTRUNNER_CLAUDE_GRANT\nunset CLAUDE_CODE_OAUTH_TOKEN\nexport ANTHROPIC_API_KEY=" + quoted + "\n"
	case AuthOpenAIAPIKey:
		return "unset CODEX_ACCESS_TOKEN\nexport OPENAI_API_KEY=" + quoted + "\n"
	case AuthCodexAccount:
		return "unset OPENAI_API_KEY CODEX_ACCESS_TOKEN\nexport OUTRUNNER_CODEX_GRANT=" + quoted + "\n"
	case AuthCodexAccessToken:
		return "unset OPENAI_API_KEY\nexport CODEX_ACCESS_TOKEN=" + quoted + "\n"
	}
	return ""
}

// SetAuth gives a session its own credential, or with AuthNone takes it away;
// either applies at the session's next launch, a running one keeps what it
// started with. The credential it replaces stays masked (keyFiles.retire).
// Callers validate kind (ValidAuthKind) and token (ValidAuthToken).
func (s *Service) SetAuth(ctx context.Context, workspaceID, kind, token string) error {
	defer s.lockLifecycle(workspaceID)()
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return ErrUnknownWorkspace // never write keys for a workspace never created
	}
	agentName := f.Agent
	if agentName == "" {
		agentName = AgentClaude
	}
	if kind != AuthNone && authAgent[kind] != agentName {
		return ErrAuthMismatch
	}
	content := ""
	if kind != AuthNone {
		if kind == AuthClaudeAccount {
			if _, err := claudeAccountEnv(token); err != nil {
				return err
			}
		}
		content = authEnvFile(kind, token)
	}
	if err := s.authFiles().put(workspaceID, content); err != nil {
		return err
	}
	if (kind != AuthOpenAIAPIKey && kind != AuthCodexAccessToken) || f.Auth != kind {
		// The Codex home logged in with a key no longer the session's must
		// not keep a copy of it.
		if err := os.Remove(filepath.Join(s.codexHome(workspaceID), "auth.json")); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if kind == AuthNone {
		kind = ""
	}
	s.updateFacts(workspaceID, func(f *workspaceFacts) { f.Auth = kind })
	s.refreshLiveSecrets()
	return nil
}

// requireAuthEnv refuses to launch a session recorded with a credential
// whose file is gone.
func (s *Service) requireAuthEnv(workspaceID string) error {
	if f, _ := s.getFacts(workspaceID); f.Auth == "" {
		return nil
	}
	if _, err := os.Stat(s.authFiles().path(workspaceID)); err != nil {
		return ErrAuthMissing
	}
	return nil
}

// A Claude broker grant is only accepted for the fixed inference endpoint.
// Neither URL nor bearer is ever interpolated into an unquoted shell command.
func claudeAccountEnv(encoded string) (string, error) {
	var grant struct {
		URL    string `json:"url"`
		Bearer string `json:"bearer"`
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if len(encoded) > 16384 || err != nil || json.Unmarshal(raw, &grant) != nil || !ValidAuthToken(AuthCodexAccount, grant.Bearer) {
		return "", errors.New("invalid Claude connection")
	}
	u, err := url.Parse(grant.URL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/api/runtime/claude" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		return "", errors.New("invalid Claude broker address")
	}
	return "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN\nexport ANTHROPIC_BASE_URL=" + claude.ShellQuote(grant.URL) +
		"\nexport CLAUDE_CODE_OAUTH_TOKEN=" + claude.ShellQuote(grant.Bearer) + "\nexport OUTRUNNER_CLAUDE_GRANT=" + claude.ShellQuote(encoded) + "\n", nil
}

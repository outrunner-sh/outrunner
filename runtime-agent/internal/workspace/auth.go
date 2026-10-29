package workspace

import (
	"context"
	"errors"
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
)

// authAgent is the agent each kind of credential is for.
var authAgent = map[string]string{
	AuthClaudeOAuthToken: AgentClaude,
	AuthAnthropicAPIKey:  AgentClaude,
	AuthOpenAIAPIKey:     AgentCodex,
	AuthCodexAccessToken: AgentCodex,
}

// ValidAuthKind accepts a kind of credential a session can be given.
func ValidAuthKind(kind string) bool {
	return kind == AuthNone || authAgent[kind] != ""
}

var (
	// ErrAuthMismatch is a credential for another agent than the session
	// runs: an OpenAI key means nothing to Claude, nor a Claude token to Codex.
	ErrAuthMismatch = errors.New("this credential is for another agent than the one this session runs")
	// ErrAuthUnsupported is a credential given on the jcode engine, whose
	// bridge runs every session on its own login: taken, it would never apply.
	ErrAuthUnsupported = errors.New("this computer's engine runs sessions on its own login and can't take a session's credential")
	// ErrAuthMissing is a session recorded with a credential whose file is
	// gone: launched anyway, it would run on whatever login the computer has.
	ErrAuthMissing = errors.New("this session's credential is missing; set it again to start the session")
)

// authKeyEnvs are the variables a session's credential is exported in.
var authKeyEnvs = []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}

// ValidAuthToken keeps API-key bounds unchanged, while accepting the longer
// opaque credentials issued for Codex workspace automation. Both go into a
// shell-sourced file, so whitespace, quotes and backslashes remain forbidden.
func ValidAuthToken(kind, token string) bool {
	if kind != AuthCodexAccessToken {
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
	case AuthClaudeOAuthToken:
		return "unset ANTHROPIC_API_KEY\nexport CLAUDE_CODE_OAUTH_TOKEN=" + quoted + "\n"
	case AuthAnthropicAPIKey:
		return "unset CLAUDE_CODE_OAUTH_TOKEN\nexport ANTHROPIC_API_KEY=" + quoted + "\n"
	case AuthOpenAIAPIKey:
		return "unset CODEX_ACCESS_TOKEN\nexport OPENAI_API_KEY=" + quoted + "\n"
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
	if err := s.CheckAuth(kind); err != nil {
		return err
	}
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
	return nil
}

// CheckAuth refuses a credential this computer can't apply: any, on the jcode
// engine. Taking one away is always fine.
func (s *Service) CheckAuth(kind string) error {
	if kind != AuthNone && s.jcode != nil {
		return ErrAuthUnsupported
	}
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

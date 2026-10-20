package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"runtime-agent/internal/claude"
)

// A session that runs through a gateway (OpenRouter) gets its key and model in
// a private file the launch sources (keyFiles), rather than in the agent's
// environment (shared by every session) or on a command line (visible in ps).

func (s *Service) gatewayFiles() keyFiles {
	return keyFiles{dir: filepath.Join(s.Root, "gateways"), envs: claude.GatewayKeyEnvs()}
}

func (s *Service) gatewayEnvPath(workspaceID string) string {
	return s.gatewayFiles().path(workspaceID)
}

// retiredGatewayPath keeps the keys a session ran on before its current one.
func (s *Service) retiredGatewayPath(workspaceID string) string {
	return s.gatewayFiles().retiredPath(workspaceID)
}

func (s *Service) readGatewayEnv(workspaceID string) string {
	return s.gatewayFiles().read(workspaceID)
}

// gatewayEnvFile renders the session's gateway environment as shell exports.
func gatewayEnvFile(g claude.Gateway, token, model string) string {
	set, unset := claude.GatewayEnv(g, token, model)
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range unset {
		b.WriteString("unset " + k + "\n")
	}
	for _, k := range keys {
		b.WriteString("export " + k + "=" + claude.ShellQuote(set[k]) + "\n")
	}
	return b.String()
}

// ErrGatewayKeyMissing is a session recorded on a gateway whose key file is
// gone: launched anyway, sourcing the missing file fails and Claude exits with
// nothing on screen to say why.
var ErrGatewayKeyMissing = errors.New("this session's model key is missing; choose its model again to restart it")

// requireGatewayEnv refuses to launch a gateway session without its key file.
func (s *Service) requireGatewayEnv(workspaceID string) error {
	if f, _ := s.getFacts(workspaceID); f.Gateway == claude.NoGateway {
		return nil
	}
	if _, err := os.Stat(s.gatewayEnvPath(workspaceID)); err != nil {
		return ErrGatewayKeyMissing
	}
	return nil
}

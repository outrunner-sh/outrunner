package workspace

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"runtime-agent/internal/claude"
)

// A session that runs through a gateway (OpenRouter) gets its key and model in
// a private file the launch sources, rather than in the agent's environment
// (shared by every session) or on a command line (visible in ps).

func (s *Service) gatewayEnvPath(workspaceID string) string {
	return filepath.Join(s.Root, "gateways", workspaceID+".env")
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

// writeGatewayEnv stores it owner-only, atomically, so a launch never sources a
// half-written file.
func (s *Service) writeGatewayEnv(workspaceID, content string) error {
	path := s.gatewayEnvPath(workspaceID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// putGatewayEnv stores the session's gateway file, or removes it for none.
func (s *Service) putGatewayEnv(workspaceID, content string) error {
	if content == "" {
		if err := os.Remove(s.gatewayEnvPath(workspaceID)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return s.writeGatewayEnv(workspaceID, content)
}

func (s *Service) readGatewayEnv(workspaceID string) string {
	data, _ := os.ReadFile(s.gatewayEnvPath(workspaceID))
	return string(data)
}

// gatewayTokens are the keys of every session on a gateway, for redaction.
// Read from the files so a restarted agent still masks the sessions tmux kept.
func (s *Service) gatewayTokens() []string {
	files, _ := filepath.Glob(filepath.Join(s.Root, "gateways", "*.env"))
	var tokens []string
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			value, ok := strings.CutPrefix(line, "export ANTHROPIC_AUTH_TOKEN=")
			if !ok {
				continue
			}
			if token := strings.Trim(value, "'"); token != "" {
				tokens = append(tokens, token)
			}
		}
	}
	return tokens
}

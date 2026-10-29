package workspace

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// The user's own agent setup, imported from their Mac: CLAUDE.md, skills,
// subagents and slash commands under the computer's ~/.claude, Codex's
// ~/.codex/AGENTS.md, and the MCP servers and Claude's plugin settings. It is the
// computer's, shared by its sessions (one user's, one project's), as it was
// on the Mac. The files come as an archive, installed item by item over what
// an earlier import installed (anything else under ~/.claude is left alone);
// the MCP servers and settings are files of their own, given to each Claude
// launch with --mcp-config and --settings, never merged into ~/.claude.json,
// which Claude rewrites as it runs. A Codex session in a home of its own gets
// the same MCP servers in its config.toml (codex_auth.go); the servers are
// the user's own with their project's under them and Outrunner's over both,
// merged by the control plane.

// ErrInvalidAgentConfig is a setup the computer can't take.
var ErrInvalidAgentConfig = errors.New("invalid agent setup")

// AgentConfigRequest is the user's setup for this computer.
type AgentConfigRequest struct {
	// Version names the archive; one installed already isn't downloaded again.
	Version string
	// URL is where the archive downloads from, and SHA256 its digest; empty
	// for a setup with no files (any installed before are removed).
	URL    string
	SHA256 string
	// MCPServers are Claude's MCP servers, by name, as ~/.claude.json has them.
	MCPServers map[string]json.RawMessage
	// Settings are Claude settings for the plugins (enabledPlugins, …).
	Settings map[string]json.RawMessage
}

// maxAgentConfigBytes bounds the archive and what it unpacks to.
const maxAgentConfigBytes = 64 << 20

// agentConfigState is what an import installed: ~/.claude/.outrunner-config.json.
type agentConfigState struct {
	Version string   `json:"version"`
	Items   []string `json:"items"`
}

var agentConfigMu sync.Mutex

func agentConfigHome() (string, error) { return os.UserHomeDir() }

func agentConfigStatePath(home string) string {
	return filepath.Join(home, ".claude", ".outrunner-config.json")
}

// mcpConfigPath and settingsPath are the files a Claude launch is given.
func mcpConfigPath(home string) string { return filepath.Join(home, ".claude", "outrunner-mcp.json") }
func settingsPath(home string) string {
	return filepath.Join(home, ".claude", "outrunner-settings.json")
}

// SetAgentConfig installs the user's setup on this computer.
func (s *Service) SetAgentConfig(ctx context.Context, req AgentConfigRequest) error {
	home, err := agentConfigHome()
	if err != nil {
		return err
	}
	agentConfigMu.Lock()
	defer agentConfigMu.Unlock()

	state := readAgentConfigState(home)
	if req.URL == "" {
		if err := installItems(home, "", state.Items, nil); err != nil {
			return err
		}
		state = agentConfigState{}
	} else if req.Version != state.Version {
		staging, err := os.MkdirTemp(home, ".outrunner-config-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(staging)
		items, err := fetchAgentConfig(ctx, req.URL, req.SHA256, staging)
		if err != nil {
			return err
		}
		if err := installItems(home, staging, state.Items, items); err != nil {
			return err
		}
		state = agentConfigState{Version: req.Version, Items: items}
	}
	if err := writeJSONFile(agentConfigStatePath(home), state, 0o600); err != nil {
		return err
	}

	// The box's own servers are added by the box, last (desktop.go): one of
	// theirs by the same name is dropped here, so it can't shadow them.
	req.MCPServers = withoutOwnServers(req.MCPServers)
	if len(req.MCPServers) > 0 {
		if err := writeJSONFile(mcpConfigPath(home), map[string]any{"mcpServers": req.MCPServers}, 0o600); err != nil {
			return err
		}
	} else {
		_ = os.Remove(mcpConfigPath(home))
	}
	if len(req.Settings) > 0 {
		return writeJSONFile(settingsPath(home), req.Settings, 0o600)
	}
	_ = os.Remove(settingsPath(home))
	return nil
}

// fetchAgentConfig downloads the archive, checks its digest, and unpacks it
// into staging; it returns the items it holds.
func fetchAgentConfig(ctx context.Context, url, digest, staging string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download the agent setup: status %d", resp.StatusCode)
	}
	archive, err := os.CreateTemp(staging, "archive-")
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(archive, sum), io.LimitReader(resp.Body, maxAgentConfigBytes+1))
	if err != nil {
		return nil, err
	}
	if n > maxAgentConfigBytes {
		return nil, fmt.Errorf("%w: the archive is too large", ErrInvalidAgentConfig)
	}
	if got := "sha256:" + hex.EncodeToString(sum.Sum(nil)); got != digest {
		return nil, fmt.Errorf("%w: the archive is not the one imported", ErrInvalidAgentConfig)
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return unpackAgentConfig(archive, filepath.Join(staging, "files"))
}

// unpackAgentConfig unpacks only folders and regular files, each inside one
// of the items a setup may have, within the size bound.
func unpackAgentConfig(r io.Reader, dst string) ([]string, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidAgentConfig, err)
	}
	tr := tar.NewReader(gz)
	items := map[string]bool{}
	var total int64
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidAgentConfig, err)
		}
		name := strings.TrimSuffix(header.Name, "/")
		item, ok := configItem(name)
		if !ok {
			return nil, fmt.Errorf("%w: %q is not part of an agent setup", ErrInvalidAgentConfig, header.Name)
		}
		target := filepath.Join(dst, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return nil, err
			}
		case tar.TypeReg:
			total += header.Size
			if total > maxAgentConfigBytes {
				return nil, fmt.Errorf("%w: it unpacks too large", ErrInvalidAgentConfig)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return nil, err
			}
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755 // a skill's script
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return nil, err
			}
			_, err = io.CopyN(file, tr, header.Size)
			if cerr := file.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("%w: %q is not a file or folder", ErrInvalidAgentConfig, header.Name)
		}
		items[item] = true
	}
	list := make([]string, 0, len(items))
	for item := range items {
		list = append(list, item)
	}
	return list, nil
}

// configItem is the item a path in a setup's archive belongs to: CLAUDE.md,
// a skill's folder, a subagent, a command, AGENTS.md. Anything else — and
// any path not clean and relative — is not part of one.
func configItem(name string) (string, bool) {
	if name == "" || path.Clean(name) != name || path.IsAbs(name) || strings.HasPrefix(name, "../") || name == ".." {
		return "", false
	}
	parts := strings.Split(name, "/")
	switch {
	case name == ".claude/CLAUDE.md", name == ".codex/AGENTS.md":
		return name, true
	case len(parts) >= 3 && parts[0] == ".claude" && parts[1] == "skills":
		return strings.Join(parts[:3], "/"), true
	case len(parts) == 3 && parts[0] == ".claude" && parts[1] == "agents" && strings.HasSuffix(parts[2], ".md"):
		return name, true
	case len(parts) >= 3 && parts[0] == ".claude" && parts[1] == "commands" && strings.HasSuffix(name, ".md"):
		return name, true
	case name == ".claude" || name == ".codex" || name == ".claude/skills" || name == ".claude/agents" || name == ".claude/commands" ||
		(len(parts) >= 3 && parts[0] == ".claude" && parts[1] == "commands"):
		return "", true // a folder holding items: nothing of its own
	}
	return "", false
}

// installItems puts each new item in place of what was there, and removes
// the items an earlier import installed that this one hasn't.
func installItems(home, staging string, previous, items []string) error {
	keep := map[string]bool{}
	for _, item := range items {
		if item == "" {
			continue
		}
		keep[item] = true
		dst := filepath.Join(home, filepath.FromSlash(item))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.RemoveAll(dst); err != nil {
			return err
		}
		if err := os.Rename(filepath.Join(staging, "files", filepath.FromSlash(item)), dst); err != nil {
			return err
		}
	}
	for _, item := range previous {
		if !keep[item] && item != "" {
			_ = os.RemoveAll(filepath.Join(home, filepath.FromSlash(item)))
		}
	}
	return nil
}

func readAgentConfigState(home string) agentConfigState {
	var state agentConfigState
	data, err := os.ReadFile(agentConfigStatePath(home))
	if err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return state
}

// writeJSONFile replaces a file with v as JSON, in one step.
func writeJSONFile(path string, v any, mode os.FileMode) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// withAgentConfig adds the imported MCP servers and settings to a Claude
// launch, when there are any.
func withAgentConfig(argv []string) []string {
	home, err := agentConfigHome()
	if err != nil {
		return argv
	}
	if fileExists(mcpConfigPath(home)) {
		argv = append(argv, "--mcp-config", mcpConfigPath(home))
	}
	if fileExists(settingsPath(home)) {
		argv = append(argv, "--settings", settingsPath(home))
	}
	return argv
}

// agentMCPServers are the MCP servers a Claude launch is given, by name, for
// a Codex launch to be given too; none when there are none.
func agentMCPServers() map[string]json.RawMessage {
	home, err := agentConfigHome()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(mcpConfigPath(home))
	if err != nil {
		return nil
	}
	var config struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if json.Unmarshal(data, &config) != nil {
		return nil
	}
	return config.MCPServers
}

// agentConfigTokens are the imported MCP servers' keys, for masking: their
// environment and headers, and a header's token after its scheme.
func agentConfigTokens() []string {
	home, err := agentConfigHome()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(mcpConfigPath(home))
	if err != nil {
		return nil
	}
	var config struct {
		MCPServers map[string]struct {
			Env     map[string]string `json:"env"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if json.Unmarshal(data, &config) != nil {
		return nil
	}
	var tokens []string
	for _, server := range config.MCPServers {
		for _, values := range []map[string]string{server.Env, server.Headers} {
			for _, value := range values {
				tokens = append(tokens, value)
				if _, token, ok := strings.Cut(value, " "); ok {
					tokens = append(tokens, token)
				}
			}
		}
	}
	var masked []string
	for _, token := range tokens {
		if len(token) >= minMaskedEnv {
			masked = append(masked, token)
		}
	}
	return masked
}

// copyAgentsMD gives a Codex home of a session's own the user's AGENTS.md.
func copyAgentsMD(codexHome string) {
	home, err := agentConfigHome()
	if err != nil {
		return
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "AGENTS.md"))
	if err != nil {
		_ = os.Remove(filepath.Join(codexHome, "AGENTS.md"))
		return
	}
	_ = os.WriteFile(filepath.Join(codexHome, "AGENTS.md"), data, 0o600)
}

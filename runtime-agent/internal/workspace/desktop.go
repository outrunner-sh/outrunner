package workspace

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strconv"

	"runtime-agent/internal/codex"
	"runtime-agent/internal/desktop"
)

// A session on a box with a desktop (Daytona's computer use) gets the desktop
// tools (package desktop): Claude Code and Codex each launch this binary's
// `desktop-mcp` as an MCP server, on the session's folder, where its
// screenshots and recordings are kept. Whether the box has a desktop is asked
// of the desktop's toolbox at each launch until it answers, and then known:
// a box doesn't lose its desktop. A session in the user's own folder (the
// Mac) never gets the tools.

// desktopToolTimeoutSeconds bounds one desktop tool call for the agent's CLI:
// past the longest the server lets a call run (a page that loads slowly).
const desktopToolTimeoutSeconds = 240

// desktopReady reports whether a launch gets the desktop tools.
func (s *Service) desktopReady(workspaceID string) bool {
	if s.RelayExecutable == "" || s.DesktopToolbox == "" {
		return false
	}
	if f, _ := s.getFacts(workspaceID); f.InPlace {
		return false
	}
	if s.desktopFound.Load() {
		return true
	}
	if desktop.Available(context.Background(), s.DesktopToolbox) {
		s.desktopFound.Store(true)
		return true
	}
	return false
}

// desktopServerArgs launch a session's desktop server, after RelayExecutable.
func desktopServerArgs(worktree string) []string {
	return []string{"desktop-mcp", "--folder", worktree}
}

// desktopConfigPath is the MCP config a Claude session launches it from.
func (s *Service) desktopConfigPath(workspaceID string) string {
	return filepath.Join(s.Root, "desktop", workspaceID+".mcp.json")
}

// claudeDesktopArgs give a Claude launch the desktop tools. Those that only
// look are allowed up front; the rest follow the session's permission mode,
// as any other tool that acts does.
func (s *Service) claudeDesktopArgs(workspaceID, worktree string) []string {
	if !s.desktopReady(workspaceID) {
		return nil
	}
	config := map[string]any{"mcpServers": map[string]any{desktop.ServerName: map[string]any{
		"type":    "stdio",
		"command": s.RelayExecutable,
		"args":    desktopServerArgs(worktree),
		"timeout": desktopToolTimeoutSeconds * 1000,
	}}}
	path := s.desktopConfigPath(workspaceID)
	if err := writeJSONFile(path, config, 0o600); err != nil {
		log.Printf("workspace %s: no desktop tools (config: %v)", workspaceID, err)
		return nil
	}
	argv := []string{"--mcp-config", path, "--allowedTools"}
	for _, name := range desktop.ReadOnlyTools {
		argv = append(argv, "mcp__"+desktop.ServerName+"__"+name)
	}
	return argv
}

// codexDesktopArgs give a Codex launch the desktop tools, as config
// overrides: Codex reads MCP servers from its config, which -c sets for
// this launch alone.
func (s *Service) codexDesktopArgs(workspaceID, worktree string) []string {
	if !s.desktopReady(workspaceID) {
		return nil
	}
	key := "mcp_servers." + desktop.ServerName + "."
	args := "["
	for i, arg := range desktopServerArgs(worktree) {
		if i > 0 {
			args += ", "
		}
		args += codex.TOMLString(arg)
	}
	args += "]"
	return []string{
		"-c", key + "command=" + codex.TOMLString(s.RelayExecutable),
		"-c", key + "args=" + args,
		"-c", key + "tool_timeout_sec=" + strconv.Itoa(desktopToolTimeoutSeconds),
	}
}

// forgetDesktop removes a destroyed session's desktop config. Its
// screenshots and recordings go with its folder.
func (s *Service) forgetDesktop(workspaceID string) {
	_ = os.Remove(s.desktopConfigPath(workspaceID))
}

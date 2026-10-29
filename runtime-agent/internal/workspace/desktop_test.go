package workspace

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"runtime-agent/internal/desktop"
)

// desktopToolbox is a box's desktop toolbox, answering its status.
func desktopToolbox(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/computeruse/status" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"status":"inactive"}`))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestASessionOnABoxWithADesktopGetsTheDesktopTools(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-a", Branch: "b", BaseBranch: "main"})
	s.RelayExecutable = "/opt/runtime-agent"
	s.DesktopToolbox = desktopToolbox(t).URL

	argv := claudeAgent{s}.command("ws-a", worktree, false)
	joined := strings.Join(argv, " ")
	for _, want := range []string{
		"--mcp-config " + s.desktopConfigPath("ws-a"),
		"--allowedTools mcp__outrunner_desktop__screenshot mcp__outrunner_desktop__browser_snapshot",
		"# Desktop",
		"Prefer an API, a CLI, or a test run",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("launch = %q, want %q", argv, want)
		}
	}
	var config struct {
		MCPServers map[string]struct {
			Type    string
			Command string
			Args    []string
		} `json:"mcpServers"`
	}
	data, err := os.ReadFile(s.desktopConfigPath("ws-a"))
	if err != nil || json.Unmarshal(data, &config) != nil {
		t.Fatalf("config: %v %s", err, data)
	}
	server := config.MCPServers[desktop.ServerName]
	if server.Type != "stdio" || server.Command != "/opt/runtime-agent" || !slices.Equal(server.Args, []string{"desktop-mcp", "--folder", worktree}) {
		t.Errorf("server = %+v", server)
	}

	// Destroyed, the session's config goes with it.
	s.forgetDesktop("ws-a")
	if _, err := os.Stat(s.desktopConfigPath("ws-a")); !os.IsNotExist(err) {
		t.Errorf("config left: %v", err)
	}
}

func TestACodexSessionGetsTheDesktopToolsAsConfigOverrides(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-c", Branch: "b", BaseBranch: "main", Agent: AgentCodex})
	s.RelayExecutable = "/opt/runtime-agent"
	s.DesktopToolbox = desktopToolbox(t).URL
	argv := codexAgent{s}.command("ws-c", worktree, false)
	for _, want := range []string{
		`mcp_servers.outrunner_desktop.command="/opt/runtime-agent"`,
		`mcp_servers.outrunner_desktop.args=["desktop-mcp", "--folder", "` + worktree + `"]`,
		`mcp_servers.outrunner_desktop.tool_timeout_sec=240`,
	} {
		i := slices.Index(argv, want)
		if i < 1 || argv[i-1] != "-c" {
			t.Errorf("launch = %q, want -c %s", argv, want)
		}
	}
	if !strings.Contains(strings.Join(argv, " "), "# Desktop") {
		t.Error("Codex isn't told about the desktop")
	}
}

func TestNoDesktopNoTools(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	for name, setup := range map[string]func(*Service){
		"no toolbox answering":      func(s *Service) { s.DesktopToolbox = closed.URL },
		"not looked for (the Mac)":  func(s *Service) { s.DesktopToolbox = "" },
		"no relay binary to launch": func(s *Service) { s.DesktopToolbox = desktopToolbox(t).URL; s.RelayExecutable = "" },
	} {
		s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-a", Branch: "b", BaseBranch: "main"})
		s.RelayExecutable = "/opt/runtime-agent"
		setup(s)
		joined := strings.Join(claudeAgent{s}.command("ws-a", worktree, false), " ")
		if strings.Contains(joined, desktop.ServerName) || strings.Contains(joined, "# Desktop") {
			t.Errorf("%s: launch = %q", name, joined)
		}
	}

	// A session in the user's own folder, whatever answers.
	s, folder := inPlaceSession(t, CreateInput{WorkspaceID: "ws-p", Branch: "b"})
	s.RelayExecutable = "/opt/runtime-agent"
	s.DesktopToolbox = desktopToolbox(t).URL
	if joined := strings.Join(claudeAgent{s}.command("ws-p", folder, false), " "); strings.Contains(joined, desktop.ServerName) {
		t.Errorf("in place: launch = %q", joined)
	}
}

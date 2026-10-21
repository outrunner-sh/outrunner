package workspace

import (
	"encoding/json"
	"net"
	"os"
	"slices"
	"strings"
	"testing"

	"runtime-agent/internal/ask"
)

func TestALaunchGivesTheAgentTheAskTool(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-a", Branch: "b", BaseBranch: "main"})
	if argv := (claudeAgent{s}).command("ws-a", worktree, false); slices.Contains(argv, "--disallowedTools") {
		t.Fatalf("no relay to launch, yet launch = %q", argv)
	}

	s.RelayExecutable = "/opt/runtime-agent"
	argv := claudeAgent{s}.command("ws-a", worktree, false)
	joined := strings.Join(argv, " ")
	for _, want := range []string{
		"--mcp-config " + s.askConfigPath("ws-a"),
		"--allowedTools " + ask.QualifiedToolName,
		"--disallowedTools AskUserQuestion",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("launch = %q, want %q", argv, want)
		}
	}
	var config struct {
		MCPServers map[string]struct {
			Command string
			Args    []string
			Timeout int
		} `json:"mcpServers"`
	}
	data, err := os.ReadFile(s.askConfigPath("ws-a"))
	if err != nil || json.Unmarshal(data, &config) != nil {
		t.Fatalf("config: %v %s", err, data)
	}
	server := config.MCPServers[ask.ServerName]
	if server.Command != "/opt/runtime-agent" || !slices.Equal(server.Args, []string{"ask-mcp", "--root", s.Root, "--workspace", "ws-a"}) {
		t.Errorf("relay = %+v", server)
	}
	if server.Timeout < 60*60*1000 {
		t.Errorf("timeout = %dms: a question must outlast Claude's 5-minute watchdog", server.Timeout)
	}

	// The token is the session's for its life: a relay from an earlier launch
	// still holds it.
	_, tokenFile := AskPaths(s.Root, "ws-a")
	token, _ := os.ReadFile(tokenFile)
	if info, err := os.Stat(tokenFile); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("token file: %v %v", info, err)
	}
	claudeAgent{s}.command("ws-a", worktree, true)
	if again, _ := os.ReadFile(tokenFile); string(again) != string(token) {
		t.Fatal("a relaunch changed the session's token")
	}
	if !s.AskAuthorized("ws-a", strings.TrimSpace(string(token))) || s.AskAuthorized("ws-a", "guess") || s.AskAuthorized("ws-b", strings.TrimSpace(string(token))) {
		t.Fatal("AskAuthorized must take only the session's own token")
	}

	s.forgetWorkspace("ws-a")
	if _, err := os.Stat(tokenFile); !os.IsNotExist(err) {
		t.Fatal("a destroyed session's token was kept")
	}
	if _, err := os.Stat(s.askConfigPath("ws-a")); !os.IsNotExist(err) {
		t.Fatal("a destroyed session's config was kept")
	}
}

func TestAnnounceIsOnTheLoopback(t *testing.T) {
	s := NewService(t.TempDir())
	if err := s.Announce(&net.TCPAddr{IP: net.IPv6unspecified, Port: 8080}); err != nil {
		t.Fatal(err)
	}
	addrFile, _ := AskPaths(s.Root, "")
	if data, _ := os.ReadFile(addrFile); string(data) != "127.0.0.1:8080\n" {
		t.Fatalf("announced %q", data)
	}
}

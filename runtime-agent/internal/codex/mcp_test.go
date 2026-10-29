package codex

import (
	"encoding/json"
	"strings"
	"testing"
)

// Codex is given the servers it can run, as config.toml tables in name
// order, every value quoted; one of a kind it doesn't speak is left out.
func TestMCPServersConfig(t *testing.T) {
	servers := map[string]json.RawMessage{
		"tracker":   json.RawMessage(`{"type":"http","url":"https://mcp.example/mcp","headers":{"Authorization":"Bearer tok \"q\""}}`),
		"db":        json.RawMessage(`{"type":"stdio","command":"npx","args":["-y","@acme/db-mcp"],"env":{"DATABASE_URL":"postgres://x","A_KEY":"k"}}`),
		"bare":      json.RawMessage(`{"command":"/usr/local/bin/srv"}`),
		"streaming": json.RawMessage(`{"type":"sse","url":"https://sse.example"}`),
		"broken":    json.RawMessage(`not json`),
	}
	want := `
[mcp_servers."bare"]
command = "/usr/local/bin/srv"
args = []
startup_timeout_sec = 60

[mcp_servers."db"]
command = "npx"
args = ["-y", "@acme/db-mcp"]
env = { "A_KEY" = "k", "DATABASE_URL" = "postgres://x" }
startup_timeout_sec = 60

[mcp_servers."tracker"]
url = "https://mcp.example/mcp"
http_headers = { "Authorization" = "Bearer tok \"q\"" }
startup_timeout_sec = 60
`
	if got := MCPServersConfig(servers, none); got != want {
		t.Errorf("MCPServersConfig =%s\nwant%s", got, want)
	}
	if got := MCPServersConfig(nil, none); got != "" {
		t.Errorf("no servers = %q", got)
	}
}

func none(string) (string, bool) { return "", false }

// Codex takes ${VAR} as text, so the servers are expanded for it as Claude
// Code expands them: from the Codex process's environment, a default where
// one is given; a server naming a variable that isn't set, with no default,
// is left out rather than started with the literal reference.
func TestMCPServersConfigExpandsVariablesAsClaudeDoes(t *testing.T) {
	env := map[string]string{"GITHUB_TOKEN": "ghp_secret", "HOME": "/home/u", "EMPTY": ""}
	lookup := func(name string) (string, bool) { v, ok := env[name]; return v, ok }
	servers := map[string]json.RawMessage{
		"github": json.RawMessage(`{"type":"http","url":"${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}","headers":{"Authorization":"Bearer ${GITHUB_TOKEN}"}}`),
		"files":  json.RawMessage(`{"command":"${HOME}/bin/files","args":["--root","${HOME}/work","--tag","${EMPTY:-unused}"],"env":{"LEVEL":"${LOG_LEVEL:-info}"}}`),
		"broken": json.RawMessage(`{"type":"http","url":"https://x","headers":{"Authorization":"Bearer ${MISSING_TOKEN}"}}`),
		"plain":  json.RawMessage(`{"command":"echo","args":["$HOME stays", "${not a ref}"]}`),
	}
	got := MCPServersConfig(servers, lookup)
	for _, want := range []string{
		"[mcp_servers.\"github\"]\nurl = \"https://api.githubcopilot.com/mcp/\"\nhttp_headers = { \"Authorization\" = \"Bearer ghp_secret\" }\n",
		"command = \"/home/u/bin/files\"\nargs = [\"--root\", \"/home/u/work\", \"--tag\", \"\"]\nenv = { \"LEVEL\" = \"info\" }\n",
		"args = [\"$HOME stays\", \"${not a ref}\"]",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("config lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "broken") || strings.Contains(got, "MISSING_TOKEN") {
		t.Errorf("a server naming an unset variable was given to Codex:\n%s", got)
	}
}

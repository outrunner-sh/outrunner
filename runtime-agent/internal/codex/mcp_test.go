package codex

import (
	"encoding/json"
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
	if got := MCPServersConfig(servers); got != want {
		t.Errorf("MCPServersConfig =%s\nwant%s", got, want)
	}
	if got := MCPServersConfig(nil); got != "" {
		t.Errorf("no servers = %q", got)
	}
}

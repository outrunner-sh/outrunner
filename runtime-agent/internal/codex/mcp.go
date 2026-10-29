package codex

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// A session's MCP servers come as Claude Code's MCP config has them (the
// user's own, their project's, and Outrunner's own, merged by the control
// plane): a stdio server's command, args and env, or an http one's url and
// headers. Codex reads the same servers from its config.toml's mcp_servers
// tables, which MCPServersConfig writes. A server of a kind Codex doesn't
// speak (Claude's sse, a WebSocket one) is left out, and Claude keeps it.

// mcpStartupTimeoutSec is how long Codex waits for a server to start: a
// first `npx -y` downloads its package, past Codex's own 10 seconds.
const mcpStartupTimeoutSec = 60

// claudeMCPServer is the part of a Claude MCP server Codex can take.
type claudeMCPServer struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

// MCPServersConfig is the config.toml tables of the servers Codex can run,
// by name in order, or "" for none. Values are in the file (the session's
// own Codex home, owner-only), as the provider's key is: Codex would pass a
// variable naming one to every command it runs.
func MCPServersConfig(servers map[string]json.RawMessage) string {
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		var server claudeMCPServer
		if json.Unmarshal(servers[name], &server) != nil || name == "" {
			continue
		}
		var body string
		switch {
		case (server.Type == "" || server.Type == "stdio") && server.Command != "":
			body = "command = " + TOMLString(server.Command) + "\n" +
				"args = " + tomlArray(server.Args) + "\n"
			if len(server.Env) > 0 {
				body += "env = " + tomlTable(server.Env) + "\n"
			}
		case server.Type == "http" && server.URL != "":
			body = "url = " + TOMLString(server.URL) + "\n"
			if len(server.Headers) > 0 {
				body += "http_headers = " + tomlTable(server.Headers) + "\n"
			}
		default:
			continue
		}
		b.WriteString("\n[mcp_servers." + TOMLString(name) + "]\n" + body)
		b.WriteString("startup_timeout_sec = " + strconv.Itoa(mcpStartupTimeoutSec) + "\n")
	}
	return b.String()
}

func tomlArray(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = TOMLString(v)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

// tomlTable is an inline table, its keys quoted (a variable or header name
// may hold what a bare key can't), in order.
func tomlTable(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, len(keys))
	for i, k := range keys {
		pairs[i] = TOMLString(k) + " = " + TOMLString(values[k])
	}
	return "{ " + strings.Join(pairs, ", ") + " }"
}

package codex

import (
	"encoding/json"
	"regexp"
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
//
// Claude Code expands ${VAR} and ${VAR:-default} in those fields from its
// environment, and imported .mcp.json files lean on it ("Authorization":
// "Bearer ${GITHUB_TOKEN}"). Codex takes the text as it is, so the servers
// are expanded here, from the environment the Codex process gets: a server
// would otherwise start with the literal ${GITHUB_TOKEN} and fail its auth
// with no word why. One naming a variable that isn't set, with no default,
// is left out, as Claude refuses a config that does.

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
//
// lookup is the Codex process's environment, for ${VAR} expansion.
func MCPServersConfig(servers map[string]json.RawMessage, lookup func(name string) (string, bool)) string {
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		var server claudeMCPServer
		if json.Unmarshal(servers[name], &server) != nil || name == "" || !expandServer(&server, lookup) {
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

// envReference is ${NAME} or ${NAME:-default}, as Claude Code expands them.
var envReference = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`)

// expandServer expands the references in every field Claude Code does
// (command, args, env, url, headers); false when one names a variable not
// set, with no default.
func expandServer(server *claudeMCPServer, lookup func(string) (string, bool)) bool {
	ok := true
	expand := func(text string) string {
		return envReference.ReplaceAllStringFunc(text, func(ref string) string {
			m := envReference.FindStringSubmatch(ref)
			if value, set := lookup(m[1]); set {
				return value
			}
			if strings.Contains(ref, ":-") {
				return m[2]
			}
			ok = false
			return ref
		})
	}
	server.Command, server.URL = expand(server.Command), expand(server.URL)
	for i, arg := range server.Args {
		server.Args[i] = expand(arg)
	}
	for _, values := range []map[string]string{server.Env, server.Headers} {
		for k, v := range values {
			values[k] = expand(v)
		}
	}
	return ok
}

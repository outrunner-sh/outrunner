// Command runtime-agent is the data-plane daemon that runs on each Runtime
// Computer. It owns git worktrees, tmux sessions, the Claude processes, PTY
// streaming, and the conversation watcher. The Next control plane talks to it
// over HTTP; the browser connects directly to WS /pty.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/claude"
	"runtime-agent/internal/jcode"
	"runtime-agent/internal/localimport"
	"runtime-agent/internal/server"
	"runtime-agent/internal/workspace"
)

func main() {
	// `runtime-agent import …` is the desktop app's: it reads this Mac's
	// sessions and exits. It serves nothing, so needs no secret.
	if len(os.Args) > 1 && os.Args[1] == "import" {
		os.Exit(localimport.Main(context.Background(), os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}

	// `runtime-agent ask-mcp …` is a session's ask_user relay, an MCP server
	// its agent's CLI launches over stdio (package ask). It serves that one
	// session, through the agent it finds under the root.
	if len(os.Args) > 1 && os.Args[1] == "ask-mcp" {
		os.Exit(askRelay(os.Args[2:]))
	}

	secret := os.Getenv("RUNTIME_AGENT_SECRET")
	if secret == "" {
		log.Fatal("RUNTIME_AGENT_SECRET is required")
	}
	root := envOr("RUNTIME_AGENT_ROOT", "/home/runtime")
	port := envOr("PORT", "8080")
	// A Runtime Computer listens on every interface (the Daytona preview proxy
	// reaches it from outside). The desktop shell passes 127.0.0.1: on someone's
	// own Mac nothing but the shell itself should be able to connect.
	host := os.Getenv("HOST")

	svc := workspace.NewService(root)
	if exe, err := os.Executable(); err == nil {
		svc.RelayExecutable = exe
	} else {
		log.Printf("runtime-agent: sessions launch without ask_user: %v", err)
	}
	if raw := os.Getenv("RUNTIME_DEFAULT_PERMISSION_MODE"); raw != "" {
		mode, err := claude.ParsePermissionMode(raw)
		if err != nil {
			log.Fatalf("RUNTIME_DEFAULT_PERMISSION_MODE: %v", err)
		}
		svc.DefaultPermissionMode = mode
	}
	if os.Getenv("RUNTIME_AGENT_EXIT_WITH_PARENT") == "1" {
		go exitWithParent()
	}

	// RUNTIME_ENGINE=jcode drives workspaces through a jcode api-bridge instead
	// of Claude-in-tmux. The bridge is expected to be running on the box; we
	// connect to its Unix socket.
	if os.Getenv("RUNTIME_ENGINE") == "jcode" {
		socket := envOr("JCODE_API_SOCKET", defaultJcodeSocket())
		client, err := jcode.Dial(context.Background(), socket, "runtime-agent")
		if err != nil {
			log.Fatalf("jcode engine: dial %s: %v", socket, err)
		}
		svc.UseJcode(client)
		log.Printf("runtime-agent: jcode engine (server=%s via %s)", client.Server(), socket)
	}

	srv := server.New(secret, svc)
	// PORT=0 asks the OS for a free port, so two desktop apps (or a stale agent)
	// can never collide. The bound address is announced on stdout, which is how
	// the shell learns where to connect.
	listener, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		log.Fatal(err)
	}
	if err := svc.Announce(listener.Addr()); err != nil {
		log.Printf("runtime-agent: sessions' questions can't reach this agent: %v", err)
	}
	fmt.Printf("RUNTIME_AGENT_ADDR=%s\n", listener.Addr())
	log.Printf("runtime-agent listening on %s (root=%s)", listener.Addr(), root)
	if err := http.Serve(listener, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}

// exitWithParent ends the agent once the process that launched it is gone. The
// desktop shell stops it on quit, but a crashed shell cannot, and an orphaned
// agent would keep listening with a secret nobody holds. On macOS an orphan is
// re-parented to launchd (pid 1).
func exitWithParent() {
	parent := os.Getppid()
	for range time.Tick(2 * time.Second) {
		if current := os.Getppid(); current != parent || current == 1 {
			log.Printf("runtime-agent: parent %d exited; shutting down", parent)
			os.Exit(0)
		}
	}
}

// defaultJcodeSocket mirrors the bridge's default ($XDG_RUNTIME_DIR/jcode-api.sock),
// falling back to /tmp when the runtime dir is unset (e.g. a bare container).
func defaultJcodeSocket() string {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = "/tmp"
	}
	return filepath.Join(dir, "jcode-api.sock")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// askRelay runs a session's ask_user relay until its agent's CLI closes it.
func askRelay(args []string) int {
	flags := flag.NewFlagSet("ask-mcp", flag.ContinueOnError)
	root := flags.String("root", "", "the runtime-agent's root")
	workspaceID := flags.String("workspace", "", "the session's workspace id")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *root == "" || *workspaceID == "" {
		fmt.Fprintln(os.Stderr, "ask-mcp: --root and --workspace are required")
		return 2
	}
	addrFile, tokenFile := workspace.AskPaths(*root, *workspaceID)
	err := ask.Relay(context.Background(), os.Stdin, os.Stdout, ask.RelayConfig{
		WorkspaceID: *workspaceID,
		AddrFile:    addrFile,
		TokenFile:   tokenFile,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "ask-mcp:", err)
		return 1
	}
	return 0
}

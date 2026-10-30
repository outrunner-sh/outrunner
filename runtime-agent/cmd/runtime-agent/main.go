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
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/autoscale"
	"runtime-agent/internal/claude"
	"runtime-agent/internal/cli"
	"runtime-agent/internal/desktop"
	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/jcode"
	"runtime-agent/internal/localimport"
	"runtime-agent/internal/media"
	"runtime-agent/internal/preview"
	"runtime-agent/internal/server"
	"runtime-agent/internal/sessiontools"
	"runtime-agent/internal/workspace"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "desktop-codex-auth" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		code := cli.DesktopCodexAuth(ctx, os.Stdin, os.Stdout)
		stop()
		os.Exit(code)
	}
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

	// `runtime-agent outrunner …` is the outrunner CLI, as a session on a
	// box runs it (`outrunner media upload`, `outrunner media gif`): the
	// agent puts a script for it first on the sessions' PATH.
	if len(os.Args) > 1 && os.Args[1] == "outrunner" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		code := cli.Main(ctx, os.Args[2:], os.Stdin, os.Stdout, os.Stderr)
		stop()
		os.Exit(code)
	}

	// `runtime-agent desktop-mcp …` is a session's desktop tools, an MCP
	// server its agent's CLI launches over stdio (package desktop). It drives
	// the box's desktop itself, through the desktop's toolbox on the box.
	if len(os.Args) > 1 && os.Args[1] == "desktop-mcp" {
		os.Exit(desktopServer(os.Args[2:]))
	}

	// `runtime-agent git-credential …` is git's credential helper for
	// github.com in a session, and `runtime-agent github-token …` the gh
	// wrapper's (package gitcred): each asks the agent it finds under the
	// root for a fresh GitHub token.
	if len(os.Args) > 1 && os.Args[1] == "git-credential" {
		os.Exit(gitCredentialHelper(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "github-token" {
		os.Exit(githubToken(os.Args[2:]))
	}

	// `runtime-agent preview …` is a session's agent making a preview of a
	// server it runs (package preview), through the agent it finds under
	// the root.
	if len(os.Args) > 1 && os.Args[1] == "preview" {
		os.Exit(preview.Main(context.Background(), os.Args[2:], os.Stdout, os.Stderr, workspace.AskPaths, nil))
	}

	// `runtime-agent session-tool …` is a session's `outrunner-session`
	// (package sessiontools): it asks the agent it finds under the root to
	// reach Outrunner for the session.
	if len(os.Args) > 1 && os.Args[1] == "session-tool" {
		os.Exit(sessionTool(os.Args[2:]))
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
	// Sessions get the desktop tools where the box turns out to have a
	// desktop (Daytona's); elsewhere nothing answers here, and they don't.
	svc.DesktopToolbox = desktop.DefaultToolbox
	if exe, err := os.Executable(); err == nil {
		svc.RelayExecutable = exe
	} else {
		log.Printf("runtime-agent: sessions launch without ask_user: %v", err)
	}
	// A box the control plane launched with the means to ask it for GitHub
	// tokens has its sessions' git and gh get fresh ones; any other (the
	// desktop app, an older control plane) keeps the token it was given.
	if cfg, ok := gitcred.ConfigFromEnv(os.Getenv); ok {
		if err := svc.UseGitCredential(&gitcred.Client{Config: cfg}); err != nil {
			log.Printf("runtime-agent: sessions keep the GitHub token they were launched with: %v", err)
		}
		// The same means make the sessions' previews.
		svc.UsePreviews(&preview.Client{AppURL: cfg.AppURL, SandboxID: cfg.SandboxID, Secret: cfg.Secret})
		// The same means let its sessions upload screenshots and recordings
		// for their pull requests (package media).
		svc.UseMedia(&media.Client{Config: cfg})
		// The daemon reads its cgroup even when no browser is connected.
		// Only the control plane can authorize and perform a memory increase.
		if os.Getenv("RUNTIME_MEMORY_AUTOSCALING") == "1" {
			monitor := &autoscale.Monitor{Config: cfg}
			go monitor.Run(context.Background())
		}
	}
	if raw := os.Getenv("RUNTIME_DEFAULT_PERMISSION_MODE"); raw != "" {
		mode, err := claude.ParsePermissionMode(raw)
		if err != nil {
			log.Fatalf("RUNTIME_DEFAULT_PERMISSION_MODE: %v", err)
		}
		svc.DefaultPermissionMode = mode
	}
	// A box the control plane launched has its sessions show their work in
	// pull requests with `outrunner media`, which uploads through this agent.
	if _, ok := gitcred.ConfigFromEnv(os.Getenv); ok {
		if err := svc.UseOutrunnerCLI(); err != nil {
			log.Printf("runtime-agent: sessions have no outrunner command: %v", err)
		}
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
	// Its own port is never one of the box's servers to open.
	srv.AgentPort = listener.Addr().(*net.TCPAddr).Port
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

// desktopServer serves a session's desktop tools on stdio
// (`desktop-mcp --folder F`), keeping its screenshots and recordings in the
// session's folder F. With --stop-recording ID --at T it is instead a
// recording's watchdog (desktop.Watchdog), which stops it at T, the Unix
// time its limit is reached, unless it has stopped by then.
func desktopServer(args []string) int {
	flags := flag.NewFlagSet("desktop-mcp", flag.ContinueOnError)
	folder := flags.String("folder", "", "the session's folder")
	stopRecording := flags.String("stop-recording", "", "a recording to stop at --at")
	at := flags.Int64("at", 0, "when to stop it, in Unix seconds")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	// DESKTOP_TOOLBOX points it at another toolbox, for a test.
	toolbox := &desktop.Toolbox{Base: envOr("DESKTOP_TOOLBOX", desktop.DefaultToolbox)}
	if *stopRecording != "" {
		if err := desktop.CapRecording(context.Background(), toolbox, *stopRecording, time.Unix(*at, 0)); err != nil {
			fmt.Fprintln(os.Stderr, "desktop-mcp: stop the recording:", err)
			return 1
		}
		return 0
	}
	if *folder == "" {
		fmt.Fprintln(os.Stderr, "desktop-mcp: --folder is required")
		return 2
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "desktop-mcp:", err)
		return 1
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "desktop-mcp:", err)
		return 1
	}
	err = desktop.Serve(context.Background(), os.Stdin, os.Stdout, desktop.Config{
		Toolbox: toolbox,
		Browser: &desktop.Browser{
			Port:    desktop.DevToolsPort,
			Profile: filepath.Join(home, ".outrunner", "desktop", "chromium"),
			Display: desktop.Display,
		},
		Folder: desktop.FilesFolder(*folder),
		// In a session of its own, so it outlives this server and the
		// session's CLI.
		Watchdog: func(id string, until time.Time) error {
			cmd := exec.Command(exe, "desktop-mcp", "--stop-recording", id, "--at", strconv.FormatInt(until.Unix(), 10))
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			// The detached process runs beyond this server; keep its retry
			// failure visible in the runtime agent's logs.
			cmd.Stderr = os.Stderr
			if err := cmd.Start(); err != nil {
				return err
			}
			return cmd.Process.Release()
		},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "desktop-mcp:", err)
		return 1
	}
	return 0
}

// gitCredentialHelper answers git's credential request on stdin
// (`git-credential --root R <op>`).
func gitCredentialHelper(args []string) int {
	flags := flag.NewFlagSet("git-credential", flag.ContinueOnError)
	root := flags.String("root", "", "the runtime-agent's root")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *root == "" {
		fmt.Fprintln(os.Stderr, "git-credential: --root is required")
		return 2
	}
	return gitcred.Helper(context.Background(), flags.Arg(0), os.Stdin, os.Stdout, os.Stderr, localAgent(*root), os.Getenv("GH_TOKEN"))
}

// sessionTool runs a session's command (`session-tool --root R <command> …`).
func sessionTool(args []string) int {
	flags := flag.NewFlagSet("session-tool", flag.ContinueOnError)
	root := flags.String("root", "", "the runtime-agent's root")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *root == "" {
		fmt.Fprintln(os.Stderr, "session-tool: --root is required")
		return 2
	}
	addrFile, tokenFile := workspace.GitCredentialPaths(*root)
	local := sessiontools.Local{AddrFile: addrFile, TokenFile: tokenFile}
	return sessiontools.Main(context.Background(), flags.Args(), os.Getenv, os.Stdin, os.Stdout, os.Stderr, local)
}

// githubToken prints a GitHub token for the gh command after "--"
// (`github-token --root R -- <gh args>`).
func githubToken(args []string) int {
	flags := flag.NewFlagSet("github-token", flag.ContinueOnError)
	root := flags.String("root", "", "the runtime-agent's root")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *root == "" {
		fmt.Fprintln(os.Stderr, "github-token: --root is required")
		return 2
	}
	return gitcred.GitHubToken(context.Background(), flags.Args(), os.Stdout, os.Stderr, localAgent(*root), os.Getenv, gitcred.OriginURL)
}

// localAgent is the agent under root, as the helpers reach it.
func localAgent(root string) gitcred.Local {
	addrFile, tokenFile := workspace.GitCredentialPaths(root)
	return gitcred.Local{AddrFile: addrFile, TokenFile: tokenFile}
}

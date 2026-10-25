// Package editor runs VS Code in the browser (code-server) on a box, for the
// session's owner to open beside its terminal and conversation.
//
// One per box: a box holds one session (each session has its own), and the
// editor opens on that session's folder through its URL's ?folder=. It runs in
// a tmux session of its own, so an agent restart leaves it up; a box paused and
// woken has it started again on the next open.
//
// It listens without a password: the box is reached only through its
// provider's signed preview URL, which the control plane mints for the
// session's owner alone, as it does for the terminal.
package editor

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/tmux"
)

// Port is where code-server listens on every box.
const Port = 8443

// Version is the code-server a box installs, for its user, the first time its
// editor is opened (about 8 seconds on Daytona). The box image doesn't carry
// one yet: its check runs on every box as it comes up, and would refuse every
// box made from the image before it.
const Version = "4.143.1"

// session is the tmux session code-server runs in.
const session = "outrunner-editor"

// startTimeout bounds waiting for a started code-server to answer.
const startTimeout = 60 * time.Second

// waitTimeout is how long one open waits for the editor before saying it's
// still starting: under the providers' proxies' request timeouts (Daytona's
// is about 30 seconds), so the caller asks again rather than being cut off.
const waitTimeout = 15 * time.Second

// ErrStarting is an editor being installed or started: ask again shortly.
var ErrStarting = errors.New("the editor is starting")

// installTimeout bounds installing code-server on a box from an older image.
const installTimeout = 3 * time.Minute

// Editor starts code-server on this box and says where it is.
type Editor struct {
	// Home is the box user's home, where a code-server it installs goes.
	Home string
	// Port overrides Port, for tests.
	Port int
	// Health is the URL to ask whether it's up; empty is its own /healthz.
	Health string
	// Start runs code-server, detached; nil runs it in tmux.
	Start func(ctx context.Context, binary string, port int) error
	// Install puts code-server on the box; nil runs code-server's installer.
	Install func(ctx context.Context) error
	// Wait overrides waitTimeout, for tests.
	Wait time.Duration

	mu       sync.Mutex
	starting chan struct{} // closed when the start under way ends
	failed   error         // why the last start failed, told once
}

func (e *Editor) port() int {
	if e.Port != 0 {
		return e.Port
	}
	return Port
}

// Ensure has code-server running and answering, and returns its port. One
// that isn't up is started (and, on a box without it, installed) in the
// background, once however many ask: an open waits a while for it, then
// returns ErrStarting for the caller to ask again. A start that failed is
// said once, by the next call, and the one after tries again.
func (e *Editor) Ensure(ctx context.Context) (int, error) {
	if e.up(ctx) {
		return e.port(), nil
	}
	e.mu.Lock()
	if err := e.failed; err != nil {
		e.failed = nil
		e.mu.Unlock()
		return 0, err
	}
	if e.starting == nil {
		done := make(chan struct{})
		e.starting = done
		go func() {
			err := e.start(context.Background())
			e.mu.Lock()
			e.failed = err
			e.starting = nil
			e.mu.Unlock()
			close(done)
		}()
	}
	done := e.starting
	e.mu.Unlock()

	wait := e.Wait
	if wait == 0 {
		wait = waitTimeout
	}
	select {
	case <-done:
		return e.Ensure(ctx)
	case <-time.After(wait):
		return 0, ErrStarting
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// start installs code-server if the box has none, starts it, and waits for
// it to answer.
func (e *Editor) start(ctx context.Context) error {
	binary, err := e.binary(ctx)
	if err != nil {
		return err
	}
	start := e.Start
	if start == nil {
		start = e.startInTmux
	}
	if err := start(ctx, binary, e.port()); err != nil {
		return fmt.Errorf("start code-server: %w", err)
	}
	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		if e.up(ctx) {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("code-server started but didn't answer: %s", tail(e.readLog(), 400))
}

// up is whether code-server answers on its port.
func (e *Editor) up(ctx context.Context) bool {
	url := e.Health
	if url == "" {
		url = "http://127.0.0.1:" + strconv.Itoa(e.port()) + "/healthz"
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// binary is the code-server to run: the image's, or one installed for the
// box user, installing it if neither is there.
func (e *Editor) binary(ctx context.Context) (string, error) {
	installed := filepath.Join(e.Home, ".local", "bin", "code-server")
	if path, err := exec.LookPath("code-server"); err == nil {
		return path, nil
	}
	if isExecutable(installed) {
		return installed, nil
	}
	install := e.Install
	if install == nil {
		install = e.installStandalone
	}
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	if err := install(ctx); err != nil {
		return "", fmt.Errorf("install code-server: %w", err)
	}
	if path, err := exec.LookPath("code-server"); err == nil {
		return path, nil
	}
	if isExecutable(installed) {
		return installed, nil
	}
	return "", errors.New("code-server was installed but isn't where it was put")
}

// installStandalone runs code-server's installer for the box user, at Version,
// into ~/.local: no root, no package manager.
func (e *Editor) installStandalone(ctx context.Context) error {
	script := "curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=\"$HOME/.local\" --version " + Version
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.Env = append(os.Environ(), "HOME="+e.Home)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, tail(string(out), 400))
	}
	return nil
}

// logPath is where code-server's output goes, for a start that fails to say why.
func (e *Editor) logPath() string { return filepath.Join(e.Home, ".outrunner-editor.log") }

func (e *Editor) readLog() string {
	data, _ := os.ReadFile(e.logPath())
	return strings.TrimSpace(string(data))
}

// startInTmux runs code-server in its own tmux session, replacing one whose
// code-server died, its output kept in its log.
func (e *Editor) startInTmux(ctx context.Context, binary string, port int) error {
	_ = tmux.Command(ctx, "kill-session", "-t", session).Run()
	_ = os.Remove(e.logPath())
	command := strings.Join([]string{
		// code-server takes $PORT over --bind-addr's port, and the agent's own
		// is in the environment it inherits.
		"PORT=" + strconv.Itoa(port),
		"exec", shellQuote(binary),
		"--bind-addr", "0.0.0.0:" + strconv.Itoa(port),
		"--auth", "none",
		"--disable-telemetry",
		"--disable-update-check",
		"--disable-workspace-trust",
		">>" + shellQuote(e.logPath()), "2>&1",
	}, " ")
	// One shell command: tmux joins separate arguments with spaces, which
	// would hand `sh -c` only the first word and start code-server with no
	// flags, on its default port (8080, the agent's own on some boxes).
	cmd := tmux.Command(ctx, "new-session", "-d", "-s", session, "-c", e.Home, command)
	cmd.Env = append(os.Environ(), "HOME="+e.Home)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, tail(string(out), 400))
	}
	return nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

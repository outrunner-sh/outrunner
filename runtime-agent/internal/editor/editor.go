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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/tmux"
)

// Port is where code-server listens on every box.
const Port = 8443

// Version is the code-server a box installs, for its user, the first time its
// editor is opened (about 9 seconds on Daytona): its release tarball, checked
// against releaseSHA256. The box image doesn't carry one yet: its check runs
// on every box as it comes up, and would refuse every box made from the image
// before it.
const Version = "4.143.1"

// releaseSHA256 is each architecture's code-server-<Version>-linux-<arch>.tar.gz.
var releaseSHA256 = map[string]string{
	"amd64": "614877cf71005f14ea252bd2d9b1c12237cf7d73681ef150f0dff7f13849fdb5",
	"arm64": "51481a891754dc2585b86d007aec24ac675453fc5ef6cfa346c4462449277384",
}

// session is the tmux session code-server runs in.
const session = "outrunner-editor"

// startTimeout bounds waiting for a started code-server to answer, while its
// tmux session lives: one that dies is said at once.
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
	// Env is what code-server, its terminals and (when it starts first) the
	// tmux server run with: the session's environment, never the agent's,
	// whose secret tmux would hand every later session.
	Env []string
	// Port overrides Port, for tests.
	Port int
	// Health is the URL to ask whether it's up; empty is its own /healthz.
	Health string
	// Start runs code-server, detached; nil runs it in tmux.
	Start func(ctx context.Context, binary string, port int) error
	// Running is whether code-server's process is still there, answering or
	// not; nil asks tmux whether its session is.
	Running func(ctx context.Context) bool
	// Stop ends a code-server that never answered; nil kills its tmux session.
	Stop func(ctx context.Context)
	// StartTimeout overrides startTimeout, for tests.
	StartTimeout time.Duration
	// Install puts code-server on the box; nil runs code-server's installer.
	Install func(ctx context.Context) error
	// Wait overrides waitTimeout, for tests.
	Wait time.Duration

	mu      sync.Mutex
	attempt *attempt // the start under way, if any
	// started counts the starts that ended with code-server up: an open that
	// found it down, then sees this moved, knows a start finished since.
	started int
}

// Health is code-server's /healthz: alive while it runs, and when someone
// last had a tab open on it.
type Health struct {
	Status        string `json:"status"`
	LastHeartbeat int64  `json:"lastHeartbeat"` // Unix milliseconds
}

// attempt is one start, and how it ended: every open waiting on it is told.
type attempt struct {
	done chan struct{}
	err  error
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
// returns ErrStarting for the caller to ask again. A start that fails is told
// to every open waiting on it; the next open tries again.
func (e *Editor) Ensure(ctx context.Context) (int, error) {
	e.mu.Lock()
	seen := e.started
	e.mu.Unlock()
	if e.up(ctx) {
		return e.port(), nil
	}
	e.mu.Lock()
	if e.started != seen {
		// Down when this asked, but a start has finished since (its
		// attempt already cleared): it's up. Should it have died in the
		// moment since, the caller's next open finds that and starts it.
		e.mu.Unlock()
		return e.port(), nil
	}
	a := e.attempt
	if a == nil {
		a = &attempt{done: make(chan struct{})}
		e.attempt = a
		go func() {
			err := e.start(context.Background())
			e.mu.Lock()
			a.err = err
			if err == nil {
				e.started++
			}
			e.attempt = nil
			e.mu.Unlock()
			close(a.done)
		}()
	}
	e.mu.Unlock()

	wait := e.Wait
	if wait == 0 {
		wait = waitTimeout
	}
	select {
	case <-a.done:
		if a.err != nil {
			return 0, a.err
		}
		return e.port(), nil
	case <-time.After(wait):
		return 0, ErrStarting
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// start has code-server answering: waiting on one whose process is there but
// slow to answer (a loaded box) rather than killing it with the user's tabs,
// else installing it if the box has none and starting it. A process that
// dies while it's waited on is said at once, with its log.
func (e *Editor) start(ctx context.Context) error {
	if !e.running(ctx) {
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
	}
	timeout := e.StartTimeout
	if timeout == 0 {
		timeout = startTimeout
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if e.up(ctx) {
			return nil
		}
		if !e.running(ctx) {
			return fmt.Errorf("code-server stopped: %s", tail(e.readLog(), 400))
		}
		time.Sleep(300 * time.Millisecond)
	}
	// Alive but answering nothing for the whole wait: wedged, not slow. Its
	// session goes, so the next open starts it fresh rather than waiting on
	// the same process again.
	if e.Stop != nil {
		e.Stop(ctx)
	} else {
		_ = tmux.Command(ctx, "kill-session", "-t", session).Run()
	}
	return fmt.Errorf("code-server started but didn't answer: %s", tail(e.readLog(), 400))
}

// running is whether code-server's process is there.
func (e *Editor) running(ctx context.Context) bool {
	if e.Running != nil {
		return e.Running(ctx)
	}
	return tmux.Command(ctx, "has-session", "-t", session).Run() == nil
}

// up is whether code-server answers on its port.
func (e *Editor) up(ctx context.Context) bool {
	url := e.healthURL()
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
	defer res.Body.Close()
	// code-server's own answer, not any server's 200: the user's dev server
	// on this port would otherwise pass for the editor.
	var h Health
	return res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&h) == nil &&
		(h.Status == "alive" || h.Status == "expired")
}

// LastUsed is when someone last had the editor open, from its heartbeat;
// zero when it isn't running or can't say. Activity counts it, so a box
// isn't paused under someone working in it.
func (e *Editor) LastUsed(ctx context.Context) time.Time {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.healthURL(), nil)
	if err != nil {
		return time.Time{}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return time.Time{}
	}
	defer res.Body.Close()
	var h Health
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&h) != nil || h.Status != "alive" {
		return time.Time{}
	}
	return time.UnixMilli(h.LastHeartbeat)
}

func (e *Editor) healthURL() string {
	if e.Health != "" {
		return e.Health
	}
	return "http://127.0.0.1:" + strconv.Itoa(e.port()) + "/healthz"
}

// binary is the code-server to run: the image's, or one installed for the
// box user, installing it if neither is there.
func (e *Editor) binary(ctx context.Context) (string, error) {
	// This release's own binary: a box with an older one (Version bumped)
	// installs this one beside it, and the link moves to it.
	installed := e.releaseBinary()
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
	if isExecutable(installed) {
		return installed, nil
	}
	if path, err := exec.LookPath("code-server"); err == nil {
		return path, nil
	}
	return "", errors.New("code-server was installed but isn't where it was put")
}

// releaseBinary is where Version's release puts code-server.
func (e *Editor) releaseBinary() string {
	return filepath.Join(e.Home, ".local", "lib", "code-server-"+Version+"-linux-"+runtime.GOARCH, "bin", "code-server")
}

// installStandalone puts code-server's release for Version in ~/.local, for
// the box user: the tarball from GitHub, checked against its pinned digest,
// unpacked to ~/.local/lib and linked into ~/.local/bin. No root, no installer
// script run from the network.
func (e *Editor) installStandalone(ctx context.Context) error {
	sum, ok := releaseSHA256[runtime.GOARCH]
	if !ok {
		return fmt.Errorf("no code-server release for %s", runtime.GOARCH)
	}
	name := "code-server-" + Version + "-linux-" + runtime.GOARCH
	url := "https://github.com/coder/code-server/releases/download/v" + Version + "/" + name + ".tar.gz"
	script := strings.Join([]string{
		"set -eu",
		"lib=\"$HOME/.local/lib\"; bin=\"$HOME/.local/bin\"",
		"mkdir -p \"$lib\" \"$bin\"",
		"tmp=$(mktemp)",
		"trap 'rm -f \"$tmp\"' EXIT",
		"curl -fsSL -o \"$tmp\" " + shellQuote(url),
		"echo " + shellQuote(sum+"  ") + "\"$tmp\" | sha256sum -c - >/dev/null",
		// Other releases go: a bumped Version doesn't leave the old behind.
		"rm -rf \"$lib\"/code-server-*-linux-*",
		"tar -xzf \"$tmp\" -C \"$lib\"",
		"ln -sfn \"$lib/" + name + "/bin/code-server\" \"$bin/code-server\"",
	}, "\n")
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.Env = append(append([]string{}, e.Env...), "HOME="+e.Home)
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

// startInTmux runs code-server in its own tmux session (start only calls it
// when that session is gone), its output kept in its log.
func (e *Editor) startInTmux(ctx context.Context, binary string, port int) error {
	_ = tmux.Command(ctx, "kill-session", "-t", session).Run()
	_ = os.Remove(e.logPath())
	command := strings.Join([]string{
		// No PORT: code-server takes it over --bind-addr's port, and its
		// terminals hand it on to the user's dev servers.
		"exec", "env", "-u", "PORT", shellQuote(binary),
		"--bind-addr", "0.0.0.0:" + strconv.Itoa(port),
		"--auth", "none",
		"--disable-telemetry",
		"--disable-update-check",
		"--disable-workspace-trust",
		">>" + shellQuote(e.logPath()), "2>&1",
	}, " ")
	// One shell command, run by tmux's shell, for the PORT and the redirect.
	cmd := tmux.Command(ctx, "new-session", "-d", "-s", session, "-c", e.Home, command)
	// The session's environment, not the agent's: if this starts the tmux
	// server, tmux keeps what it was started with for every later session.
	cmd.Env = append(append([]string{}, e.Env...), "HOME="+e.Home)
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

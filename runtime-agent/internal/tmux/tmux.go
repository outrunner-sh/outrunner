// Package tmux manages the tmux sessions that keep Claude alive across browser
// disconnects. One tmux session per workspace; the server is independent of the
// agent process, so sessions survive an agent restart (validated in Spike 2).
package tmux

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// The server Runtime talks to. On a Runtime Computer the box is ours, so the
// default server is fine. On someone's own Mac it is not: their tmux sessions
// would mix with ours and their ~/.tmux.conf would restyle Claude's pane. The
// desktop shell sets both to give the agent a private server.
var (
	// socketName selects a named server socket (`tmux -L`).
	socketName = os.Getenv("RUNTIME_TMUX_SOCKET")
	// configFile replaces ~/.tmux.conf when the server starts (`tmux -f`).
	configFile = os.Getenv("RUNTIME_TMUX_CONFIG")
)

// Args prefixes a tmux argv with the server-selection flags. Every tmux
// invocation in the agent goes through it, or one of them would talk to a
// different server than the rest.
func Args(args ...string) []string {
	base := make([]string, 0, 4+len(args))
	if socketName != "" {
		base = append(base, "-L", socketName)
	}
	if configFile != "" {
		base = append(base, "-f", configFile)
	}
	return append(base, args...)
}

// Command builds a tmux invocation against Runtime's server.
func Command(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, "tmux", Args(args...)...)
}

// Manager runs tmux commands via the local binary.
type Manager struct{}

func New() *Manager { return &Manager{} }

// NewSession starts a detached session named `name` running `command` in
// `workdir`, with the given extra environment. Returns an error if it already
// exists or tmux fails.
func (m *Manager) NewSession(ctx context.Context, name, workdir string, command []string, env []string) error {
	args := []string{"new-session", "-d", "-s", name, "-c", workdir}
	args = append(args, command...)
	cmd := Command(ctx, args...)
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session %s: %v: %s", name, err, out)
	}
	m.HideStatus(ctx, name)
	return nil
}

// HideStatus turns off tmux's status line for one session. Claude Code draws
// its own footer, and the browser terminal shows a single pane, so tmux's bar
// would only spend a row on the session name and a clock. Best-effort: a
// session that keeps its bar works the same.
func (m *Manager) HideStatus(ctx context.Context, name string) {
	_ = Command(ctx, "set-option", "-t", name, "status", "off").Run()
}

// HasSession reports whether a session with the given name exists.
func (m *Manager) HasSession(ctx context.Context, name string) bool {
	return Command(ctx, "has-session", "-t", name).Run() == nil
}

// KillSession terminates a session (and the process inside it). A missing
// session is not an error.
func (m *Manager) KillSession(ctx context.Context, name string) error {
	if !m.HasSession(ctx, name) {
		return nil
	}
	if out, err := Command(ctx, "kill-session", "-t", name).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux kill-session %s: %v: %s", name, err, out)
	}
	return nil
}

// Paste stages `text` in the session's active pane without submitting it. It
// goes through a tmux buffer with bracketed paste (paste-buffer -p) rather than
// `send-keys -l`: a literal send-keys turns every embedded newline into a
// submit, so a multi-line prompt would fire its first line early and scatter
// the rest. Bracketed paste makes Claude insert those newlines as input, ready
// for one Enter to submit the whole thing. Loading via stdin (`load-buffer -`)
// also sidesteps arg-length and quoting limits and keeps the exact bytes intact.
//
// Submit is a separate step (SubmitEnter) because a just-launched Claude accepts
// the pasted text but silently drops the Enter for a few seconds during startup;
// the caller re-submits the already-staged text rather than re-pasting it.
func (m *Manager) Paste(ctx context.Context, name, text string) error {
	if !m.HasSession(ctx, name) {
		return fmt.Errorf("tmux paste: no session %s", name)
	}
	buf := "runtime-send-" + name
	load := Command(ctx, "load-buffer", "-b", buf, "-")
	load.Stdin = strings.NewReader(text)
	if out, err := load.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux load-buffer %s: %v: %s", name, err, out)
	}
	// -p: bracketed paste (newlines land as input, not submits). -d: delete the
	// buffer afterward so buffers don't accumulate across sends.
	if out, err := Command(ctx, "paste-buffer", "-t", name, "-b", buf, "-d", "-p").CombinedOutput(); err != nil {
		return fmt.Errorf("tmux paste-buffer %s: %v: %s", name, err, out)
	}
	return nil
}

// SubmitEnter presses Enter in the session's active pane, submitting whatever is
// currently staged in Claude's composer.
func (m *Manager) SubmitEnter(ctx context.Context, name string) error {
	return m.PressKey(ctx, name, "Enter")
}

// PressKey presses one key, by its tmux name (Enter, Down), in the session's
// active pane.
func (m *Manager) PressKey(ctx context.Context, name, key string) error {
	if out, err := Command(ctx, "send-keys", "-t", name, key).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys %s %s: %v: %s", key, name, err, out)
	}
	return nil
}

// CapturePane returns the current visible contents of the session's active
// pane. Used to detect when Claude's TUI has finished mounting and is ready to
// accept a submitted prompt.
func (m *Manager) CapturePane(ctx context.Context, name string) (string, error) {
	out, err := Command(ctx, "capture-pane", "-t", name, "-p").Output()
	if err != nil {
		return "", fmt.Errorf("tmux capture-pane %s: %w", name, err)
	}
	return string(out), nil
}

// ListSessions returns the names of all live sessions.
func (m *Manager) ListSessions(ctx context.Context) ([]string, error) {
	out, err := Command(ctx, "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		// tmux exits non-zero when there is no server/sessions; treat as empty.
		return nil, nil
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

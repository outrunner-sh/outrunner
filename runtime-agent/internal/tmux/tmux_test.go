package tmux

import (
	"context"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestArgsSelectsRuntimesServer(t *testing.T) {
	defer func(socket, config string) { socketName, configFile = socket, config }(socketName, configFile)

	socketName, configFile = "", ""
	if got := Args("has-session", "-t", "ws-1"); !slices.Equal(got, []string{"has-session", "-t", "ws-1"}) {
		t.Errorf("Runtime Computer argv = %v, want the default server", got)
	}

	// The desktop shell's private server, ignoring the user's ~/.tmux.conf.
	socketName, configFile = "outrunner", "/dev/null"
	want := []string{"-L", "outrunner", "-f", "/dev/null", "attach", "-t", "ws-1"}
	if got := Args("attach", "-t", "ws-1"); !slices.Equal(got, want) {
		t.Errorf("desktop argv = %v, want %v", got, want)
	}
}

func TestNewSessionHidesTheStatusLine(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	defer func(socket, config string) { socketName, configFile = socket, config }(socketName, configFile)
	// A throwaway server, so nothing here touches a real one.
	socketName, configFile = "runtime-test-"+strconv.Itoa(os.Getpid()), os.DevNull
	ctx := context.Background()
	defer func() { _ = Command(ctx, "kill-server").Run() }()

	m := New()
	if err := m.NewSession(ctx, "ws-status", t.TempDir(), []string{"sleep", "30"}, os.Environ()); err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	out, err := Command(ctx, "show-options", "-t", "ws-status", "status").Output()
	if err != nil {
		t.Fatalf("show-options: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "status off" {
		t.Errorf("session status option = %q, want %q", got, "status off")
	}
}

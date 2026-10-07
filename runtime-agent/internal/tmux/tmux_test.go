package tmux

import (
	"slices"
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

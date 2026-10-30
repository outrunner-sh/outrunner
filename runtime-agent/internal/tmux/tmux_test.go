package tmux

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
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

func TestSessionExistsTellsGoneFromFailed(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	// Cleanups run last-first: the PATH (set last) is restored, then this
	// test's own server is stopped by its explicit socket, then the package
	// settings are put back. Never a bare kill-server, which after the restore
	// would stop whatever server the settings name.
	prevSocket, prevConfig := socketName, configFile
	t.Cleanup(func() { socketName, configFile = prevSocket, prevConfig })
	socket := "sessionexists-" + strconv.Itoa(os.Getpid())
	socketName, configFile = socket, "/dev/null"
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })
	m, ctx := New(), context.Background()

	// No server at all: gone, not a failure.
	if ok, err := m.SessionExists(ctx, "ws-x"); ok || err != nil {
		t.Fatalf("no server: SessionExists = %v, %v; want false, nil", ok, err)
	}
	if err := Command(ctx, "new-session", "-d", "-s", "ws-live", "sleep 30").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	if ok, err := m.SessionExists(ctx, "ws-live"); !ok || err != nil {
		t.Errorf("live session: SessionExists = %v, %v; want true, nil", ok, err)
	}
	if ok, err := m.SessionExists(ctx, "ws-gone"); ok || err != nil {
		t.Errorf("no such session: SessionExists = %v, %v; want false, nil", ok, err)
	}

	// A tmux that fails for another reason must not read as "gone".
	bin := t.TempDir()
	fake := "#!/bin/sh\necho 'server exited unexpectedly' >&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "tmux"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	if ok, err := m.SessionExists(ctx, "ws-live"); ok || err == nil {
		t.Errorf("failing tmux: SessionExists = %v, %v; want an error", ok, err)
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

func TestNewSessionWithLongInstructions(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	defer func(socket, config string) { socketName, configFile = socket, config }(socketName, configFile)
	socketName, configFile = "runtime-long-"+strconv.Itoa(os.Getpid()), os.DevNull
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	defer func() { _ = Command(context.Background(), "kill-server").Run() }()
	root := t.TempDir()
	launchDir := filepath.Join(root, "launch files 'quoted'")
	if err := os.Mkdir(launchDir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", launchDir)
	output := filepath.Join(root, "received")
	// Runners add their delegation instructions to the agent's system prompt.
	// Include shell syntax to ensure spilling argv never interprets its contents.
	want := strings.Repeat("Runner instructions: 'quotes' \"double\" $HOME `false` $(false) \\ 中文\n", 700)
	command := []string{"sh", "-c", `printf '%s' "$1" > "$2"; exec sleep 30`, "test-launch", want, output}
	m := New()
	if err := m.NewSession(ctx, "ws-long", root, command, os.Environ()); err != nil {
		t.Fatalf("NewSession with %d instruction bytes: %v", len(want), err)
	}
	for {
		got, err := os.ReadFile(output)
		if err == nil && string(got) == want {
			break
		}
		if ctx.Err() != nil {
			t.Fatalf("command did not receive the exact instructions: %v (read: %v, bytes: %d)", ctx.Err(), err, len(got))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if files, err := os.ReadDir(launchDir); err != nil || len(files) != 0 {
		t.Fatalf("launch files retained after start: %v, %v", files, err)
	}
	// Refusing a duplicate session must clean up the unexecuted launch too.
	if err := m.NewSession(ctx, "ws-long", root, command, os.Environ()); err == nil {
		t.Fatal("duplicate NewSession unexpectedly succeeded")
	}
	if files, err := os.ReadDir(launchDir); err != nil || len(files) != 0 {
		t.Fatalf("launch files retained after failure: %v, %v", files, err)
	}
}

func TestLaunchScriptIsPrivateAndRejectsNUL(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	path, err := writeLaunchScript([]string{"true"})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("launch script permissions: %v, %v", info, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := writeLaunchScript([]string{"true", "invalid\x00argument"}); err == nil {
		t.Fatal("NUL argument was accepted")
	}
	if files, err := os.ReadDir(root); err != nil || len(files) != 0 {
		t.Fatalf("invalid launch left files: %v, %v", files, err)
	}
}

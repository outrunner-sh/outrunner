package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheSessionsGetOutrunnerFirstOnTheirPath(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-o", Branch: "b", BaseBranch: "main"})
	// Without it, a launch is as it was.
	if argv := s.launchCommand("ws-o", worktree, false); argv[0] == "env" && strings.Contains(strings.Join(argv, " "), "OUTRUNNER_SESSION_ID") {
		t.Fatalf("launch = %q before the command is set up", argv)
	}

	s.RelayExecutable = "/opt/runtime agent"
	if err := s.UseOutrunnerCLI(); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(s.outrunnerCLIPath())
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(s.outrunnerCLIPath()); info.Mode().Perm()&0o111 == 0 {
		t.Fatal("the outrunner script isn't executable")
	}
	if want := "exec '/opt/runtime agent' outrunner \"$@\""; !strings.Contains(string(script), want) || !strings.Contains(string(script), "OUTRUNNER_BOX_ROOT='"+s.Root+"'") {
		t.Fatalf("script = %q", script)
	}
	path := envValue(s.SessionEnv(), "PATH")
	if first := filepath.SplitList(path)[0]; first != s.gitBinDir() {
		t.Fatalf("PATH = %q, want %s first", path, s.gitBinDir())
	}
	// Set up again (an agent restart): still once on the PATH.
	_ = s.UseOutrunnerCLI()
	if n := strings.Count(envValue(s.SessionEnv(), "PATH"), s.gitBinDir()); n != 1 {
		t.Fatalf("PATH has the folder %d times", n)
	}

	argv := s.launchCommand("ws-o", worktree, false)
	if argv[0] != "env" || argv[1] != "OUTRUNNER_SESSION_ID=ws-o" {
		t.Fatalf("launch = %q, want it to say which session it is", argv)
	}
	// It proves itself with the session's ask token, made if it had none.
	_, tokenFile := AskPaths(s.Root, "ws-o")
	if data, err := os.ReadFile(tokenFile); err != nil || strings.TrimSpace(string(data)) == "" {
		t.Fatalf("no ask token for the session: %v", err)
	}
}

// The script runs what it names, with the root, and passes arguments as
// they were.
func TestTheOutrunnerScriptRuns(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "agent")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho \"$OUTRUNNER_BOX_ROOT|$*\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "outrunner")
	if err := os.WriteFile(script, []byte(OutrunnerCLIScript(fake, "/home/it's")), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(script, "media", "upload", "a b.png").Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "/home/it's|outrunner media upload a b.png" {
		t.Fatalf("ran %q", got)
	}
}

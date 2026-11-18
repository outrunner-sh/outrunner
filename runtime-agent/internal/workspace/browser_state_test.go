package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"

	"runtime-agent/internal/desktop"
)

// A session with a desktop browser, and `outrunner` to read its sign-ins
// with, is told how its browser tests start signed in, and where the
// browser's DevTools are; a session without either is told neither, and
// can't read sign-ins.
func TestASessionWithADesktopBrowserIsToldHowTestsStartSignedIn(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-a", Branch: "b", BaseBranch: "main"})
	s.RelayExecutable = "/opt/runtime-agent"
	s.Browser = desktop.NewBrowser(t.TempDir())
	if err := s.UseOutrunnerCLI(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.BrowserState(context.Background(), "ws-a", nil); !errors.Is(err, ErrNoDesktopBrowser) {
		t.Errorf("no desktop: err = %v", err)
	}
	launch := strings.Join(s.launchCommand("ws-a", worktree, false), " ")
	if strings.Contains(launch, BrowserCDPEnv) || strings.Contains(launch, "outrunner browser state") {
		t.Errorf("no desktop: launch = %q", launch)
	}

	s.DesktopToolbox = desktopToolbox(t).URL
	launch = strings.Join(s.launchCommand("ws-a", worktree, false), " ")
	for _, want := range []string{
		BrowserCDPEnv + "=http://127.0.0.1:19222",
		"outrunner browser state --origin",
		"-o playwright/.auth/state.json",
	} {
		if !strings.Contains(launch, want) {
			t.Errorf("launch = %q, want %q", launch, want)
		}
	}
}

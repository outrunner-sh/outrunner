package workspace

import (
	"context"
	"errors"

	"runtime-agent/internal/desktop"
)

// A session's own browser tests (Playwright's) start signed in from the box's
// browser: `outrunner browser state` in its terminal asks this agent, proving
// it is the session with its ask token, for the browser's sign-ins as
// Playwright's storageState (desktop.StorageState). The agent reads them
// rather than the command: one reader, the same browser the desktop tools
// drive, and the command stays one that builds for every platform.

// ErrNoDesktopBrowser is a session with no desktop browser to read: a box
// without a desktop, or a session in the user's own folder (the Mac).
var ErrNoDesktopBrowser = errors.New("this session's computer has no desktop browser to read sign-ins from")

// BrowserState is the box's browser's sign-ins for workspaceID's session:
// its cookies, and localStorage for origins and the tabs open, with a warning
// for each tab's that couldn't be read.
func (s *Service) BrowserState(ctx context.Context, workspaceID string, origins []string) (desktop.StorageState, []string, error) {
	if s.Browser == nil || !s.desktopReady(workspaceID) {
		return desktop.StorageState{}, nil, ErrNoDesktopBrowser
	}
	return s.Browser.StorageState(ctx, origins)
}

// BrowserCDPEnv names where the desktop browser's DevTools are, in the
// environment of a session that has one.
const BrowserCDPEnv = "OUTRUNNER_BROWSER_CDP_URL"

// withDesktopBrowser has a launch whose session has a desktop browser say
// where its DevTools are, for a script that drives the signed-in browser
// itself (Playwright's connectOverCDP). Unchanged for any other.
func (s *Service) withDesktopBrowser(workspaceID string, argv []string) []string {
	if s.Browser == nil || !s.desktopReady(workspaceID) {
		return argv
	}
	return append([]string{"env", BrowserCDPEnv + "=" + s.Browser.DevToolsURL()}, argv...)
}

// browserStateNote is the orientation's note on starting browser tests
// signed in, for a session that can: a desktop browser, and `outrunner`.
func (s *Service) browserStateNote(workspaceID string) string {
	if s.Browser == nil || !s.outrunnerCLI || !s.desktopReady(workspaceID) {
		return ""
	}
	return desktop.BrowserStateInstructions
}

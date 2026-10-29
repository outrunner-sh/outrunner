package workspace

import (
	"context"
	"errors"
	"fmt"
	"log"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/preview"
)

// A session's agent makes a preview of a server it runs (package preview)
// with `runtime-agent preview <port>`, which asks this agent with the
// session's ask token (AskPaths), and this agent asks the control plane.
// Only on a box the control plane launched with the means to ask it
// (gitcred.ConfigFromEnv): the desktop app has no previews.

// UsePreviews has the sessions' previews made through client's control
// plane. Called once at start, after RelayExecutable is known.
func (s *Service) UsePreviews(client *preview.Client) {
	if s.RelayExecutable == "" {
		return
	}
	s.previews = client
}

// PreviewsEnabled reports whether the sessions can make previews here.
func (s *Service) PreviewsEnabled() bool { return s.previews != nil }

// ErrNoPreviews is a box whose control plane makes no previews.
var ErrNoPreviews = errors.New("this computer makes no previews")

// CreatePreview asks the control plane for a preview of port for the
// session, or the one the port has.
func (s *Service) CreatePreview(ctx context.Context, workspaceID string, port int, label string) (preview.Preview, error) {
	if s.previews == nil {
		return preview.Preview{}, ErrNoPreviews
	}
	return s.previews.Create(ctx, workspaceID, port, label)
}

// previewsNote tells the session's agent how to make a preview, in its
// orientation; empty where it can't. The session's ask token, which the
// command proves itself with, is made here when the session has none yet
// (a Codex session, which has no ask_user relay).
func (s *Service) previewsNote(workspaceID string) string {
	if s.previews == nil {
		return ""
	}
	if _, err := s.askToken(workspaceID); err != nil {
		log.Printf("workspace %s: no previews (token: %v)", workspaceID, err)
		return ""
	}
	command := fmt.Sprintf("%s preview --root %s --workspace %s --label %s <port>",
		gitcred.ShellQuote(s.RelayExecutable), gitcred.ShellQuote(s.Root), workspaceID, gitcred.ShellQuote("Web app"))
	return "# Previews\n\n" +
		"When you run a server the user should see (a web app, an API), make a preview of it: a stable link they can open and share. " +
		"Start the server listening on 0.0.0.0 on a port from 1024 to 65535 (not 8080, this box's own), then run:\n\n" +
		"    " + command + "\n\n" +
		"It prints the preview's link; give it to the user in your final message. Running it again for the same port prints the same link. " +
		"The link opens for the user and members of their org who can see the repository, after they sign in to Outrunner; " +
		"only the user can make it public, in Outrunner. The server is reached at its own address, so a dev server that checks the Host " +
		"must allow it (for Vite, `server.allowedHosts: true`); one that builds absolute URLs should use the X-Forwarded-Host and " +
		"X-Forwarded-Proto headers. For an OAuth callback, register the preview's link plus the callback's path with the provider."
}

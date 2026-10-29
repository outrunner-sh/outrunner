package workspace

import (
	"context"
	"errors"
	"path/filepath"

	"runtime-agent/internal/media"
)

// A session's agent shows its work in its pull request with screenshots and
// GIFs it uploads to Outrunner (package media): through its upload_media tool
// (the ask relay's), or `outrunner media upload` in its terminal. Either asks
// this agent, proving it is the session with its ask token, and the agent
// uploads with its own secret, which the session never sees.

// ErrNoMedia is a box whose control plane takes no uploads: the desktop app,
// or a box launched without the means to ask (gitcred.ConfigFromEnv).
var ErrNoMedia = errors.New("this computer can't upload files to Outrunner")

// UseMedia has the sessions' uploads go to client's control plane.
func (s *Service) UseMedia(client *media.Client) { s.media = client }

// UploadMedia uploads the file at path, for workspaceID. A relative path is
// the session's own, in its worktree.
func (s *Service) UploadMedia(ctx context.Context, workspaceID, path string, opts media.Options) (media.Result, error) {
	if s.media == nil {
		return media.Result{}, ErrNoMedia
	}
	if path == "" {
		return media.Result{}, &media.Error{Message: "name the file to upload"}
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(s.worktreePath(workspaceID), path)
	}
	return s.media.Upload(ctx, workspaceID, path, opts)
}

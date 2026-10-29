package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A cloud session's guide is Outrunner's own standing instructions for it,
// beyond the orientation: how it writes a pull request, with evidence of a
// change a person can see (lib/session/pr-template.ts in the control plane,
// which writes it for the session's box and user). The control plane sends it
// with the session (CreateWorkspaceRequest's Guide), so a PR the agent opens
// on its own, not only through Create PR, is written the same way. It comes
// after the orientation and before the project's instructions, which are the
// user's and so have the last word.

// maxGuideBytes bounds a guide: a few pages.
const maxGuideBytes = 32 << 10

func (s *Service) guidePath(workspaceID string) string {
	return filepath.Join(s.Root, "instructions", workspaceID+".guide.md")
}

// SetGuide gives a session its guide, replacing any it had; empty leaves the
// one it has, since a create repeated by a control plane that sends none
// (an older one) shouldn't take it away.
func (s *Service) SetGuide(workspaceID, guide string) error {
	guide = strings.TrimSpace(guide)
	if guide == "" {
		return nil
	}
	if len(guide) > maxGuideBytes || strings.ContainsRune(guide, 0) {
		return fmt.Errorf("%w: guide too large", ErrInvalidEnvironment)
	}
	return writeKeysFile(s.guidePath(workspaceID), guide+"\n")
}

// guide is the session's guide, or "".
func (s *Service) guide(workspaceID string) string {
	data, _ := os.ReadFile(s.guidePath(workspaceID))
	return strings.TrimSpace(string(data))
}

// removeGuide removes a destroyed session's guide.
func (s *Service) removeGuide(workspaceID string) { _ = os.Remove(s.guidePath(workspaceID)) }

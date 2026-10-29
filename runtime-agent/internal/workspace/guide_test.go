package workspace

import (
	"errors"
	"strings"
	"testing"
)

func TestTheGuideComesAfterTheOrientationAndBeforeTheProjectsInstructions(t *testing.T) {
	s, worktree := cloudSession(t, CreateInput{WorkspaceID: "ws-g", Branch: "b", BaseBranch: "main"})
	if strings.Contains(s.orientation("ws-g", worktree), "# Pull requests") {
		t.Fatal("a guide before one was given")
	}
	if err := s.SetGuide("ws-g", "# Pull requests\n\nWrite it this way."); err != nil {
		t.Fatal(err)
	}
	if err := s.SetInstructions("ws-g", "Use pnpm."); err != nil {
		t.Fatal(err)
	}
	o := s.orientation("ws-g", worktree)
	guide, project := strings.Index(o, "# Pull requests\n\nWrite it this way."), strings.Index(o, "# Project instructions")
	if guide < 0 || project < 0 || guide > project || !strings.HasPrefix(o, "You are working inside Outrunner") {
		t.Fatalf("orientation = %q", o)
	}
	// Both agents launch with it.
	if argv := strings.Join(s.launchCommand("ws-g", worktree, false), " "); !strings.Contains(argv, "Write it this way.") {
		t.Fatalf("launch = %q", argv)
	}

	// A create repeated without one keeps it; one too large is refused.
	if err := s.SetGuide("ws-g", ""); err != nil || !strings.Contains(s.orientation("ws-g", worktree), "Write it this way.") {
		t.Fatalf("an empty guide took it away (%v)", err)
	}
	if err := s.SetGuide("ws-g", strings.Repeat("x", maxGuideBytes+1)); !errors.Is(err, ErrInvalidEnvironment) {
		t.Fatalf("a huge guide: err = %v", err)
	}

	// It goes with the session.
	s.removeEnvironment("ws-g")
	if s.guide("ws-g") != "" {
		t.Fatal("the guide outlived its session")
	}
}

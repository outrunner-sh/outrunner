package workspace

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

// stoppedSession creates an in-place workspace in its own folder, not running.
func stoppedSession(t *testing.T) (*Service, *fakeSessions, string, string) {
	t.Helper()
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	s.tmux = fake
	const id = "ws-stopped"
	folder := t.TempDir()
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: folder}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { s.stopRecorder(context.Background(), id) })
	return s, fake, id, folder
}

func TestStartRefusesADeletedSession(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	if err := s.Destroy(context.Background(), id); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if _, err := s.Start(context.Background(), id, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Fatalf("Start after delete = %v, want ErrUnknownWorkspace", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("a deleted session was launched: %q", fake.launches)
	}
}

func TestStartAndResumeRefuseAWorkspaceWhoseFolderIsGone(t *testing.T) {
	t.Parallel()
	s, fake, id, folder := stoppedSession(t)
	if err := os.RemoveAll(folder); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(context.Background(), id, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("Start = %v, want ErrUnknownWorkspace", err)
	}
	if _, err := s.Resume(context.Background(), id, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("Resume = %v, want ErrUnknownWorkspace", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("tmux was asked to start in a missing folder: %q", fake.launches)
	}
}

func TestStartStillStartsASessionWhoseFolderIsThere(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !fake.HasSession(context.Background(), sessionName(id)) {
		t.Error("no session running after Start")
	}
}

// Claude Code's folder-trust dialog, as two versions draw it in a fresh folder.
const (
	// 2.1.295: "No, exit" listed first, and selected.
	trustNoFirst = ` Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`
	trustNoFirstMoved = ` Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
   No, exit
 ❯ Yes, I trust this folder
 Enter to confirm · Esc to cancel`
	// 2.1.247: "Yes" listed first, and selected.
	trustYesFirst = ` Quick safety check: Is this a project you created or one you trust?
 ❯ 1. Yes, I trust this folder
   2. No, exit`
)

func TestTrustKeyMovesToYesBeforeEnter(t *testing.T) {
	for _, c := range []struct{ name, pane, want string }{
		{"No first and selected", trustNoFirst, "Down"},
		{"moved onto Yes", trustNoFirstMoved, "Enter"},
		{"Yes first and selected", trustYesFirst, "Enter"},
		{"older wording", "│ Do you trust the files in this folder? │\n│ ❯ 1. Yes, proceed │\n│   2. No, exit │", "Enter"},
		{"Yes above the selection", "   Yes, I trust this folder\n ❯ No, exit", "Up"},
		// Unknown options: no key at all, since any could mean "No".
		{"wording it doesn't know", "Do you trust this folder?\n ❯ Sure\n   Nope", ""},
	} {
		if got := trustKey(c.pane); got != c.want {
			t.Errorf("%s: trustKey = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestStartAnswersYesWhicheverWayTheTrustDialogIsOrdered(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name, pane string
		keys       []string
	}{
		{"No first", trustNoFirst, []string{"Down", "Enter"}},
		{"Yes first", trustYesFirst, []string{"Enter"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			s, fake, id, _ := stoppedSession(t)
			fake.pane = c.pane
			fake.onKey = func(key string) string {
				switch key {
				case "Down":
					return trustNoFirstMoved
				case "Enter":
					if c.pane == trustNoFirst && !slices.Contains(fake.keys, "Down") {
						// "No, exit", which the agent used to press: Claude quits.
						delete(fake.running, sessionName(id))
						return ""
					}
					return "❯ \n  ⏵⏵ accept edits on" // the composer: trusted
				}
				return ""
			}
			if _, err := s.Start(context.Background(), id, ""); err != nil {
				t.Fatalf("Start: %v", err)
			}
			if !slices.Equal(fake.keys, c.keys) {
				t.Errorf("keys pressed = %q, want %q", fake.keys, c.keys)
			}
		})
	}
}

func TestStartReportsAClaudeThatExitsAsItStarts(t *testing.T) {
	t.Parallel()
	s, fake, id, folder := stoppedSession(t)
	fake.exitAtOnce = true // e.g. an old Claude Code: "unknown option '--session-id'"
	_, err := s.Start(context.Background(), id, "")
	if !errors.Is(err, errClaudeExited) || !strings.Contains(err.Error(), folder) {
		t.Fatalf("Start = %v, want errClaudeExited naming the folder to look in", err)
	}
}

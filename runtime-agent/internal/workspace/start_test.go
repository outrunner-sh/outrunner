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
					return composerPane // trusted
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

// Panes as Claude Code draws them in tmux (2.1.295 unless noted), trimmed.
const (
	composerPane = `────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle)`
	// 2.0.x: the same box, with > for its prompt and a placeholder.
	composer20Pane = `────────────────────────────────────────────────────────────
> Try "refactor .env.example"
────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle)`
	themePane = ` Let's get started.
 Choose the text style that looks best with your terminal
 To change this later, run /theme
     Auto (match terminal)
 ❯ ✔ Dark mode
     Light mode
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1  function greet() {`
	securityPane = ` Security notes:
 1. Claude can make mistakes
    You should always review Claude's responses, especially when running code.
 Press Enter to continue…`
	permissionPane = ` Bash command
   rm -rf build
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands
   3. No, and tell Claude what to do differently (esc)`
)

func TestIsComposerTellsThePromptBoxFromMenus(t *testing.T) {
	for _, c := range []struct {
		name, pane string
		want       bool
	}{
		{"prompt box", composerPane, true},
		{"2.0's prompt box", composer20Pane, true},
		{"prompt box with a prompt typed", strings.Replace(composerPane, "❯ ", "❯ fix the tests", 1), true},
		{"theme picker", themePane, false},
		{"security notes", securityPane, false},
		{"trust dialog", trustNoFirst, false},
		{"permission question", permissionPane, false},
		{"blank", "", false},
	} {
		if got := isComposer(c.pane); got != c.want {
			t.Errorf("%s: isComposer = %v, want %v", c.name, got, c.want)
		}
		menu := c.pane != "" && !c.want
		if got := awaitsAnswer(c.pane); got != menu {
			t.Errorf("%s: awaitsAnswer = %v, want %v", c.name, got, menu)
		}
	}
}

func TestStartGetsPastAFirstRunsScreens(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	// Claude Code's first run on a Mac, then a folder it hasn't seen.
	screens := map[string]string{themePane: securityPane, securityPane: trustNoFirst}
	fake.pane = themePane
	fake.onKey = func(key string) string {
		switch {
		case key == "Enter" && screens[fake.pane] != "":
			return screens[fake.pane]
		case key == "Down" && fake.pane == trustNoFirst:
			return trustNoFirstMoved
		case key == "Enter" && fake.pane == trustNoFirstMoved:
			return composerPane
		}
		return ""
	}
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if want := []string{"Enter", "Enter", "Down", "Enter"}; !slices.Equal(fake.keys, want) {
		t.Errorf("keys pressed = %q, want %q", fake.keys, want)
	}
	if fake.pane != composerPane {
		t.Errorf("Start returned before Claude's prompt box showed: %q", fake.pane)
	}
}

func TestASendTypesNothingIntoAMenu(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	fake.pane = permissionPane // "1" or Enter here would answer Yes
	if err := s.SendMessage(id, "1"); !errors.Is(err, errAwaitsAnswer) {
		t.Fatalf("SendMessage = %v, want errAwaitsAnswer", err)
	}
	if fake.pastes != 0 || fake.enters != 0 {
		t.Errorf("typed into the menu: %d pastes, %d Enters", fake.pastes, fake.enters)
	}
}

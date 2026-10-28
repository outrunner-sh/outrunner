package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"runtime-agent/internal/claude"
)

// Panes captured from a real Claude Code 2.1.304 (the version a box runs),
// driven in tmux as this agent drives it: launched in plan mode able to
// bypass, a plan proposed and revised, approved in its own menu, a turn
// stopped with Escape, then /compact. testdata/claude-2.1.304/*.txt.
func realPane(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "claude-2.1.304", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestClaude2_1_304ScreensReadAsTheyAre(t *testing.T) {
	for _, c := range []struct {
		pane                   string
		composer, busy, awaits bool
		startupKey             string
	}{
		{pane: "trust", awaits: true, startupKey: "Down"},          // "No, exit" preselected
		{pane: "bypass-warning", awaits: true, startupKey: "Down"}, // likewise
		{pane: "plan-ready", composer: true},
		{pane: "busy", composer: true, busy: true},
		{pane: "plan-menu", awaits: true},
		// From here the session has a name, in the rule over its prompt box.
		{pane: "built", composer: true},
		{pane: "busy-tool", composer: true, busy: true},
		{pane: "after-esc", composer: true},
		{pane: "compacting", composer: true, busy: true},
	} {
		p := realPane(t, c.pane)
		a := claudeAgent{}
		if got := isComposer(p); got != c.composer {
			t.Errorf("%s: isComposer = %v, want %v", c.pane, got, c.composer)
		}
		if got := claudeIsBusy(p); got != c.busy {
			t.Errorf("%s: busy = %v, want %v", c.pane, got, c.busy)
		}
		if got := awaitsAnswer(p); got != c.awaits {
			t.Errorf("%s: awaitsAnswer = %v, want %v", c.pane, got, c.awaits)
		}
		if got := a.startupKey(p); got != c.startupKey {
			t.Errorf("%s: startupKey = %q, want %q", c.pane, got, c.startupKey)
		}
	}
}

// The real plan menu: its bypass option ("Yes, and switch to BYPASS
// PERMISSIONS (no further prompts) for this session") is preselected, so
// approving is Enter, and that is what was pressed in the capture.
func TestClaude2_1_304PlanMenuIsApprovedWithEnter(t *testing.T) {
	p := realPane(t, "plan-menu")
	if got := keyToward(p, planChoice.MatchString, planOption(claude.Bypass)); got != "Enter" {
		t.Errorf("bypass: key = %q, want Enter", got)
	}
	if got := keyToward(p, planChoice.MatchString, planOption(claude.Default)); got != "Down" {
		t.Errorf("default: key = %q, want Down to \"Yes, manually approve edits\"", got)
	}
	// Not offered on this menu (the session may bypass): approved by prompt.
	if got := keyToward(p, planChoice.MatchString, planOption(claude.AcceptEdits)); got != "" {
		t.Errorf("acceptEdits: key = %q, want none", got)
	}
}

// The warning's words in a resumed conversation's scrollback, over the prompt
// box, are no warning: nothing is pressed into the box.
func TestTheBypassWarningIsTheDialogNotItsWords(t *testing.T) {
	quoted := "  WARNING: Claude Code running in Bypass Permissions mode\n  ❯ No, exit\n    Yes, I accept\n\n" + composerPane
	if isBypassWarning(quoted) || (claudeAgent{}).startupKey(quoted) != "" {
		t.Error("the prompt box was taken for the bypass warning")
	}
	if !isBypassWarning(realPane(t, "bypass-warning")) {
		t.Error("the real warning wasn't read as one")
	}
}

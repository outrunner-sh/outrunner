package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"runtime-agent/internal/codex"
)

// codexAgent runs OpenAI's Codex CLI (codex-cli 0.146.0, whose screens the
// readers below were written against: see the pane captures in testdata).
type codexAgent struct{ s *Service }

// ErrCodexMissing is a Codex session on a computer without the Codex CLI:
// launched anyway, tmux would show "command not found" and the session would
// end with nothing to say why.
var ErrCodexMissing = fmt.Errorf("Codex isn't installed on this computer. Install it with `%s`, then start the session again", codex.InstallHint)

// prepare finds Codex, then readies the session's own Codex home when it has
// an OpenAI key (prepareCodexHome); without one, Codex runs in the user's.
func (a codexAgent) prepare(ctx context.Context, workspaceID string) error {
	if _, err := a.s.lookPath("codex"); err != nil {
		return ErrCodexMissing
	}
	if a.s.ownCodexHome(workspaceID) {
		if err := a.s.prepareCodexHome(ctx, workspaceID); err != nil {
			return err
		}
	}
	return a.s.prepareRollout(workspaceID)
}

// command launches Codex with the session's orientation, model and mode, and
// resumes its conversation by id once Codex has recorded one: in a folder
// other Codex sessions may share, "the latest" could be any of them.
func (a codexAgent) command(workspaceID, worktree string, _ bool) []string {
	s := a.s
	f, _ := s.getFacts(workspaceID)
	argv := codex.Command(s.permissionMode(workspaceID), f.CodexSessionID, f.Model, s.orientation(workspaceID, worktree))
	return append(s.codexLaunchEnv(workspaceID), argv...)
}

// env is the agent's own: a Claude login token means nothing to Codex.
func (a codexAgent) env(string) []string {
	return append([]string{}, a.s.env...)
}

func (codexAgent) isComposer(pane string) bool   { return isCodexComposer(pane) }
func (codexAgent) awaitsAnswer(pane string) bool { return codexAwaitsAnswer(pane) }

// isBusy reads Codex's status line, which offers "esc to interrupt" while a
// turn runs. Codex hides that line while it streams a reply into the screen
// (busy-streaming.txt), so a switch then isn't refused: it ends the reply.
func (codexAgent) isBusy(pane string) bool { return strings.Contains(pane, "esc to interrupt") }

// startupKey answers Codex's folder-trust question, its only screen before the
// prompt box once it is logged in. Anything else (a login menu) is left for
// the user.
func (codexAgent) startupKey(pane string) string {
	if !strings.Contains(pane, "Do you trust the contents of this directory?") {
		return ""
	}
	yes := func(line string) bool { return strings.Contains(line, "Yes, continue") }
	return keyToward(pane, codexChoice.MatchString, yes)
}

// sessionLog is the session's translated conversation, once it has a record.
func (a codexAgent) sessionLog(workspaceID string) string {
	path := conversationPath(a.s.Root, workspaceID)
	if info, err := os.Stat(path); err != nil || info.Size() == 0 {
		return ""
	}
	return path
}

// userTurns counts the prompts in the session's rollout itself, not its
// translation: a send then sees its prompt land as soon as Codex records it.
func (a codexAgent) userTurns(workspaceID string) int {
	if rollout := a.s.codexRollout(workspaceID); rollout != "" {
		return countUserMessages(rollout)
	}
	return 0
}

var errCodexExited = errors.New("Codex exited as soon as it started")

// exited points at Codex's own terminal, for the same reason as claudeExited.
func (codexAgent) exited(folder string) error {
	return fmt.Errorf("%w. To see why, run `codex` in a terminal in %s", errCodexExited, folder)
}

// codexChoice is a menu's selected option: "› 1. Yes, proceed (y)". Codex
// draws its prompt with the same ›, but never followed by a number and a dot
// unless that's what was typed (isCodexComposer is checked first).
var codexChoice = regexp.MustCompile(`^› \d+\. `)

// isCodexComposer reports whether a pane shows Codex's prompt box, ready for
// input: at the bottom, a line starting with its prompt (›), perhaps continued
// on indented lines, right above its footer ("<model> <effort> · <folder>").
// A menu (the trust question, an approval) ends in "Press enter to …" instead,
// and the prompts in the history above are never directly over the footer.
func isCodexComposer(pane string) bool {
	if strings.Contains(pane, "Press enter to") {
		return false
	}
	lines := nonBlankLines(pane)
	if len(lines) < 2 || !strings.Contains(lines[len(lines)-1], " · ") {
		return false
	}
	for i := len(lines) - 2; i >= 0; i-- {
		switch line := lines[i]; {
		case strings.HasPrefix(line, "›"):
			return true
		case !strings.HasPrefix(line, "  "):
			return false
		}
	}
	return false
}

// codexAwaitsAnswer reports whether Codex shows a menu instead of its prompt
// box: an approval ("Press enter to confirm or esc to cancel"), the trust
// question ("Press enter to continue"), or any menu with an option selected.
func codexAwaitsAnswer(pane string) bool {
	if isCodexComposer(pane) {
		return false
	}
	if strings.Contains(pane, "Press enter to confirm") || strings.Contains(pane, "Press enter to continue") {
		return true
	}
	for _, line := range strings.Split(pane, "\n") {
		if codexChoice.MatchString(line) {
			return true
		}
	}
	return false
}

// nonBlankLines are a pane's lines with something on them, trailing spaces
// trimmed.
func nonBlankLines(pane string) []string {
	var lines []string
	for _, line := range strings.Split(pane, "\n") {
		if line = strings.TrimRight(line, " "); strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

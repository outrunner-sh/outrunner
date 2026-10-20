package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"runtime-agent/internal/claude"
)

// claudeAgent runs Claude Code: the agent every session ran before there was
// a choice, and still the default.
type claudeAgent struct{ s *Service }

func (a claudeAgent) env(anthropicToken string) []string {
	return claude.SessionEnv(a.s.env, anthropicToken)
}

func (claudeAgent) isComposer(pane string) bool   { return isComposer(pane) }
func (claudeAgent) isBusy(pane string) bool       { return claudeIsBusy(pane) }
func (claudeAgent) awaitsAnswer(pane string) bool { return awaitsAnswer(pane) }

// startupKey answers the first-run screens, then the folder-trust dialog.
func (claudeAgent) startupKey(pane string) string {
	key := firstRunKey(pane)
	if key == "" && isTrustDialog(pane) {
		key = trustKey(pane)
	}
	return key
}

func (claudeAgent) exited(folder string) error { return claudeExited(errClaudeExited, folder) }

var errClaudeExited = errors.New("Claude Code exited as soon as it started")

// claudeExited says where to look. What Claude printed as it exited is gone
// with its session: tmux can't keep it (on macOS a pty drops what an
// instantly exiting process wrote last), so its own terminal is the way to
// see it.
func claudeExited(err error, folder string) error {
	return fmt.Errorf("%w. To see why, run `claude` in a terminal in %s", err, folder)
}

// isComposer reports whether a pane shows Claude's prompt box, ready for
// input: a line starting with its prompt (❯ in 2.1, > in 2.0) right under a
// horizontal rule. The theme picker, the trust dialog and permission questions
// show ❯ too, as an indented selection, and never under a rule; taking any ❯
// for the prompt once typed a user's first message into the theme picker
// ("prompt not confirmed delivered after 20 attempts").
func isComposer(pane string) bool {
	previous := ""
	for _, line := range strings.Split(pane, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if (strings.HasPrefix(line, "❯") || strings.HasPrefix(line, ">")) && isRule(previous) {
			return true
		}
		previous = line
	}
	return false
}

func isRule(line string) bool {
	line = strings.TrimSpace(line)
	return utf8.RuneCountInString(line) >= 10 && strings.Trim(line, "─") == ""
}

// awaitsAnswer reports whether Claude is showing a menu instead of its prompt
// box: a question, a permission prompt, a first-run screen. Typing a prompt
// there would be read as a choice ("1", Enter: Yes), so it waits for the user.
func awaitsAnswer(pane string) bool {
	if isComposer(pane) {
		return false
	}
	if firstRunKey(pane) != "" {
		return true
	}
	for _, line := range strings.Split(pane, "\n") {
		// A menu's selection is indented (or boxed); the prompt starts the line.
		if i := strings.Index(line, "❯"); i > 0 {
			return true
		}
	}
	return false
}

// firstRunKey answers the screens Claude Code shows the first time it runs on
// a Mac, before any session can start: logging in through Outrunner doesn't
// get past them. The theme picker takes the theme it preselects, the security
// notes need Enter. Login isn't one: Outrunner asks for it before a session.
func firstRunKey(pane string) string {
	switch {
	case strings.Contains(pane, "Choose the text style"):
		return "Enter"
	case strings.Contains(pane, "Security notes:") && strings.Contains(pane, "to continue"):
		return "Enter"
	}
	return ""
}

// isTrustDialog reports whether a pane shows Claude Code's folder-trust prompt,
// in either of the wordings it has shipped with.
func isTrustDialog(pane string) bool {
	return strings.Contains(pane, "trust this folder") ||
		strings.Contains(pane, "trust the files in this folder")
}

// trustKey is the key that takes Claude's folder-trust dialog toward "Yes":
// Enter once "Yes" is the selected option (❯), else the arrow toward it.
// Which option comes first, and which is selected, changed between Claude
// Code versions: 2.1.247 lists and preselects "Yes", 2.1.287 lists "No, exit"
// first and preselects it, so a plain Enter would close the session. Empty
// when the pane doesn't show both, since any key could then mean "No".
func trustKey(pane string) string {
	selected, yes := -1, -1
	for i, line := range strings.Split(pane, "\n") {
		if selected < 0 && strings.Contains(line, "❯") {
			selected = i
		}
		if strings.Contains(line, "Yes, I trust this folder") || strings.Contains(line, "Yes, proceed") {
			yes = i
		}
	}
	switch {
	case selected < 0 || yes < 0:
		return ""
	case selected == yes:
		return "Enter"
	case yes > selected:
		return "Down"
	default:
		return "Up"
	}
}

// claudeIsBusy reports whether Claude's screen shows a turn in progress: its
// footer offers "esc to interrupt" only then.
func claudeIsBusy(pane string) bool {
	return strings.Contains(pane, "esc to interrupt")
}

// command is Claude's argv for (re)launching a workspace's session,
// continuing its conversation when resume is set. An in-place session's
// conversation is named by id: it starts under that id and is resumed by it,
// once its transcript exists, whatever else shares the folder. Any other
// session continues the newest conversation in its own worktree.
func (a claudeAgent) command(workspaceID, worktree string, resume bool) []string {
	s := a.s
	mode, orientation := s.permissionMode(workspaceID), s.orientation(workspaceID, worktree)
	f, _ := s.getFacts(workspaceID)
	var argv []string
	switch {
	case f.ClaudeSessionID != "" && s.SessionLog(workspaceID) != "":
		argv = claude.ResumeCommand(mode, f.ClaudeSessionID, orientation)
	case f.ClaudeSessionID != "":
		argv = claude.SessionCommand(mode, f.ClaudeSessionID, orientation)
	case resume:
		argv = claude.ContinueCommand(mode, orientation)
	default:
		argv = claude.Command(mode, orientation)
	}
	if f.Gateway != claude.NoGateway {
		// The model rides in the gateway file: --model refuses a gateway's names.
		return claude.WithEnvFile(argv, s.gatewayEnvPath(workspaceID))
	}
	return claude.WithModel(argv, f.Model)
}

// claudeConvDir is where Claude writes this workspace's conversation JSONL:
// $HOME/.claude/projects/<slug>. It uses os.UserHomeDir() + claudeProjectDir —
// the same derivation as SessionLog and conversationDest — rather than s.Root,
// so it stays correct when HOME and Root differ.
func (s *Service) claudeConvDir(workspaceID string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = s.Root // best-effort fallback if HOME is unavailable
	}
	return claudeProjectDir(home, s.worktreePath(workspaceID))
}

// userTurnCount totals the user messages Claude has recorded across the *.jsonl
// files in dir (0 if it doesn't exist yet). We count user turns specifically
// rather than total bytes so an in-flight assistant reply — which also grows the
// log — can't be mistaken for our prompt being accepted. Each conversation entry
// is one JSON line; parse its `type` field (rather than substring-matching
// `"type":"user"`, which can appear inside an assistant turn's content).
func userTurnCount(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		count += fileUserTurns(filepath.Join(dir, e.Name()))
	}
	return count
}

// fileUserTurns counts the user messages in one conversation file (0 if it
// doesn't exist yet).
func fileUserTurns(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var rec struct {
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(line), &rec) == nil && rec.Type == "user" {
			count++
		}
	}
	return count
}

// userTurns counts the user messages in a workspace's conversation: its own
// transcript when the conversation is named by id (an in-place session, whose
// folder other conversations may share), else every transcript in its worktree's
// project directory.
func (a claudeAgent) userTurns(workspaceID string) int {
	s := a.s
	if f, _ := s.getFacts(workspaceID); f.ClaudeSessionID != "" {
		return fileUserTurns(filepath.Join(s.claudeConvDir(workspaceID), f.ClaudeSessionID+".jsonl"))
	}
	return userTurnCount(s.claudeConvDir(workspaceID))
}

// sessionLog returns the current Claude JSONL path for a workspace, or "" if
// Claude hasn't written anything yet. Claude Code stores per-project logs at
// ~/.claude/projects/<slug>/<sessionId>.jsonl (see claudeSlug). A worktree is
// the session's own, and --continue reuses its file, so "newest jsonl" ==
// "current session"; an in-place session's conversation is named by id.
func (a claudeAgent) sessionLog(workspaceID string) string {
	s := a.s
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := claudeProjectDir(home, s.worktreePath(workspaceID))
	if f, _ := s.getFacts(workspaceID); f.ClaudeSessionID != "" {
		path := filepath.Join(dir, f.ClaudeSessionID+".jsonl")
		if _, err := os.Stat(path); err != nil {
			return ""
		}
		return path
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var newest string
	var newestMod time.Time
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newestMod) {
			newestMod = info.ModTime()
			newest = filepath.Join(dir, e.Name())
		}
	}
	return newest
}

// claudeProjectDir is the directory Claude Code keeps a working directory's
// conversation logs in. Claude names it after its real working directory, so
// symlinks are resolved first: on macOS /var and /tmp live under /private, and
// a symlinked checkout or home is common. A path that does not exist yet is
// used as given.
func claudeProjectDir(home, worktree string) string {
	if resolved, err := filepath.EvalSymlinks(worktree); err == nil {
		worktree = resolved
	}
	return filepath.Join(home, ".claude", "projects", claudeSlug(worktree))
}

// claudeSlug encodes a filesystem path the way Claude Code names its
// per-project JSONL directory (read from Claude Code 2.1's bundle). It runs
// `path.replace(/[^a-zA-Z0-9]/g, "-")` on a JavaScript string, so the unit is a
// UTF-16 code unit, not a byte or a rune: "é" becomes one '-', an emoji two.
// A slug over claudeSlugMax units is cut there and suffixed with '-' and the
// base-36 absolute value of the path's 32-bit Java-style string hash.
func claudeSlug(path string) string {
	units := utf16.Encode([]rune(path))
	b := make([]byte, len(units))
	var hash int32 // (h<<5)-h+c|0 in JavaScript: wraps exactly like int32
	for i, u := range units {
		hash = hash*31 + int32(u)
		if u >= 'a' && u <= 'z' || u >= 'A' && u <= 'Z' || u >= '0' && u <= '9' {
			b[i] = byte(u)
		} else {
			b[i] = '-'
		}
	}
	if len(b) <= claudeSlugMax {
		return string(b)
	}
	abs := int64(hash)
	if abs < 0 {
		abs = -abs
	}
	return string(b[:claudeSlugMax]) + "-" + strconv.FormatInt(abs, 36)
}

// claudeSlugMax is the longest slug Claude Code keeps whole.
const claudeSlugMax = 200

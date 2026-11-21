package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/transcript"
)

// claudeAgent runs Claude Code: the agent every session ran before there was
// a choice, and still the default.
type claudeAgent struct{ s *Service }

// prepare has nothing to ready: Claude needs only its argv and environment.
func (claudeAgent) prepare(context.Context, string) error { return nil }

func (a claudeAgent) env(anthropicToken string) []string {
	return claude.SessionEnv(a.s.env, anthropicToken)
}

func (claudeAgent) isComposer(pane string) bool   { return isComposer(pane) }
func (claudeAgent) isBusy(pane string) bool       { return claudeIsBusy(pane) }
func (claudeAgent) awaitsAnswer(pane string) bool { return awaitsAnswer(pane) }
func (claudeAgent) typedLines(styledPane string) int {
	return claudeTypedLines(styledPane)
}

// startupKey answers the first-run screens, then the folder-trust dialog,
// then the warning a session that may bypass its permissions opens on.
func (claudeAgent) startupKey(pane string) string {
	key := firstRunKey(pane)
	if key == "" && isTrustDialog(pane) {
		key = trustKey(pane)
	}
	if key == "" && isBypassWarning(pane) {
		key = bypassKey(pane)
	}
	return key
}

// isBypassWarning reports whether a pane shows the warning Claude Code opens
// on when it may bypass its permissions (--permission-mode bypassPermissions,
// or a plan launched able to: --allow-dangerously-skip-permissions). Claude
// Code 2.1.304 shows it at every such launch, whatever ~/.claude.json's
// bypassPermissionsModeAccepted says, with "No, exit" preselected
// (testdata/claude-2.1.304/bypass-warning.txt).
//
// The dialog itself, not its words anywhere: a resumed conversation that
// quotes them (this repository's own could) shows its prompt box, and keys
// pressed there would go into it.
func isBypassWarning(pane string) bool {
	return strings.Contains(pane, "WARNING: Claude Code running in Bypass Permissions mode") &&
		strings.Contains(pane, "No, exit") && !isComposer(pane)
}

// bypassKey takes that warning toward "Yes, I accept". Bypass is Outrunner's
// choice for a session on its own disposable box (a folder of the user's is
// never launched so, ErrBypassInFolder): the user made it in choosing where
// the session runs, as they did the folder it trusts.
func bypassKey(pane string) string {
	selected := func(line string) bool { return strings.Contains(line, "❯") }
	yes := func(line string) bool { return strings.Contains(line, "Yes, I accept") }
	return keyToward(pane, selected, yes)
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

// claudeTypedLines reads Claude's prompt box off a styled capture: the rows
// from its prompt (❯, or > in 2.0) down to the rule under it, and how many
// they are when any holds text. The box is the last such prompt on the
// screen: the conversation above can hold one too (a quoted line after a
// reply's divider). Claude draws its placeholders dim ("Try …", "Press up to
// edit queued messages"), so dim text isn't counted: only what was typed and
// left there, such as a prompt a stop handed back.
func claudeTypedLines(styledPane string) int {
	rows := strings.Split(styledPane, "\n")
	box, previous := -1, ""
	for i, row := range rows {
		plain := visibleText(row, true)
		if strings.TrimSpace(plain) == "" {
			continue
		}
		if (strings.HasPrefix(plain, "❯") || strings.HasPrefix(plain, ">")) && isRule(previous) {
			box = i
		}
		previous = plain
	}
	if box < 0 {
		return 0
	}
	lines, typed := 0, false
	for j, row := range rows[box:] {
		text := visibleText(row, false)
		if j > 0 && isRule(visibleText(row, true)) {
			break
		}
		if j == 0 {
			text = strings.TrimLeft(text, "❯>")
		}
		lines++
		typed = typed || strings.TrimSpace(text) != ""
	}
	if !typed {
		return 0
	}
	return lines
}

// visibleText is a styled row's text without its escape sequences; without
// what's drawn dim (SGR 2, until 22 or a reset) too, unless withDim.
func visibleText(row string, withDim bool) string {
	var out strings.Builder
	dim := false
	for i := 0; i < len(row); i++ {
		if row[i] != '\x1b' {
			if withDim || !dim {
				out.WriteByte(row[i])
			}
			continue
		}
		// CSI: ESC [ parameters, then a final byte in @..~.
		if i+1 >= len(row) || row[i+1] != '[' {
			i++ // a two-byte escape
			continue
		}
		j := i + 2
		for j < len(row) && (row[j] < '@' || row[j] > '~') {
			j++
		}
		if j < len(row) && row[j] == 'm' {
			params := strings.Split(row[i+2:j], ";")
			for k := 0; k < len(params); k++ {
				switch params[k] {
				case "", "0", "22":
					dim = false
				case "2":
					dim = true
				case "38", "48", "58":
					// A colour's own numbers ("38;5;2") aren't attributes.
					if k+1 < len(params) && params[k+1] == "5" {
						k += 2
					} else if k+1 < len(params) && params[k+1] == "2" {
						k += 4
					}
				}
			}
		}
		i = j
	}
	return out.String()
}

func isRule(line string) bool {
	line = strings.TrimSpace(line)
	if utf8.RuneCountInString(line) < 10 {
		return false
	}
	if strings.Trim(line, "─") == "" {
		return true
	}
	// Claude Code 2.1.304 names the session in the rule once it has a name
	// ("──── add-double-function-test ─", testdata/claude-2.1.304/built.txt).
	return strings.HasPrefix(line, strings.Repeat("─", 10)) && strings.HasSuffix(line, "─")
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

// Claude 2.1.304 and 2.1.310 open this menu after a quota error. A switch may
// dismiss it with Escape: waiting for the old provider is exactly what the
// user is switching away from. Other questions and approvals stay blocked.
func isClaudeLimitDialog(pane string) bool {
	if isComposer(pane) {
		return false
	}
	lines := nonBlankLines(pane)
	if len(lines) < 4 || strings.TrimSpace(lines[len(lines)-1]) != "Enter to confirm · Esc to cancel" {
		return false
	}
	return strings.TrimSpace(lines[len(lines)-4]) == "What do you want to do?" &&
		strings.Contains(lines[len(lines)-3], "1. Stop and wait for limit to reset") &&
		strings.Contains(lines[len(lines)-2], "2. Wait here, then continue automatically at ")
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
	selected := func(line string) bool { return strings.Contains(line, "❯") }
	yes := func(line string) bool {
		return strings.Contains(line, "Yes, I trust this folder") || strings.Contains(line, "Yes, proceed")
	}
	return keyToward(pane, selected, yes)
}

// claudeIsBusy reports whether Claude's screen shows a turn in progress: its
// footer offers "esc to interrupt" only then. With its prompt box on screen,
// only what is under the box is the footer: the conversation above can quote
// the words (a reply about them), and a session reading busy for that refuses
// every edit and switch until the reply scrolls away.
func claudeIsBusy(pane string) bool {
	if footer, ok := claudeFooter(pane); ok {
		return strings.Contains(footer, "esc to interrupt")
	}
	return strings.Contains(pane, "esc to interrupt")
}

// claudeFooter is what Claude draws under its prompt box: the lines after the
// rule that closes the last box on screen (the conversation above can hold a
// quoted prompt too, as claudeTypedLines says). ok is false with no box.
func claudeFooter(pane string) (string, bool) {
	lines := strings.Split(pane, "\n")
	prompt, previous := -1, ""
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if (strings.HasPrefix(line, "❯") || strings.HasPrefix(line, ">")) && isRule(previous) {
			prompt = i
		}
		previous = line
	}
	if prompt < 0 {
		return "", false
	}
	for i := prompt + 1; i < len(lines); i++ {
		if isRule(lines[i]) {
			return strings.Join(lines[i+1:], "\n"), true
		}
	}
	return "", false
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
	if f.ClaudeSessionID == "" && resume && len(s.chatKeys(workspaceID)) > 0 {
		// --continue takes the folder's newest conversation, which may be
		// one of the session's other chats'.
		s.pinClaudeSession(workspaceID)
		f, _ = s.getFacts(workspaceID)
		// A main chat with no log of its own must start afresh. Folder-wide
		// --continue could select one of the other chats' conversations.
		resume = f.ClaudeSessionID != ""
	}
	var argv []string
	switch {
	case f.ClaudeSessionID != "" && a.sessionLog(workspaceID) != "":
		argv = claude.ResumeCommand(mode, f.ClaudeSessionID, orientation)
	case f.ClaudeSessionID != "":
		argv = claude.SessionCommand(mode, f.ClaudeSessionID, orientation)
	case resume:
		argv = claude.ContinueCommand(mode, orientation)
	default:
		argv = claude.Command(mode, orientation)
	}
	// Claude's own flags first: the env files below wrap the command.
	argv = claude.WithEffort(argv, s.claudeEffort(workspaceID, f.Effort))
	// Planning in a session that builds without asking: bypass is offered when
	// the plan is approved (ApprovePlan picks it in Claude's menu), which
	// Claude does only for a session it may bypass in.
	if mode == claude.Plan && s.buildMode(workspaceID) == claude.Bypass && s.claudeTakes("--allow-dangerously-skip-permissions") {
		argv = append(argv, "--allow-dangerously-skip-permissions")
	}
	argv = withAgentConfig(argv)
	if askArgs := s.claudeAskArgs(workspaceID); len(askArgs) > 0 {
		argv = append(argv, askArgs...)
	}
	argv = append(argv, s.claudeSubagentArgs(workspaceID)...)
	// Install the environment hook even without the ask relay when the
	// session has project variables. This also applies to its other chats.
	if s.RelayExecutable != "" || fileExists(s.envFiles().path(s.owner(workspaceID))) {
		if settings := s.claudeSecretsLaunch(workspaceID); settings != "" {
			argv = append(withoutFlag(argv, "--settings"), "--settings", settings)
		}
	}
	// Desktop tools are added after the user and project MCP servers.
	argv = append(argv, s.claudeDesktopArgs(workspaceID, worktree)...)
	if f.Gateway != claude.NoGateway {
		// The model rides in the gateway file: --model refuses a gateway's names.
		argv = claude.WithEnvFile(argv, s.gatewayEnvPath(workspaceID))
	} else {
		argv = claude.WithModel(argv, f.Model)
	}
	if f.Auth != "" {
		// Sourced first, so a gateway's file, sourced after it, wins.
		argv = claude.WithEnvFile(argv, s.authFiles().path(workspaceID))
	}
	return argv
}

// claudeConvDir is where Claude writes this workspace's conversation JSONL:
// $HOME/.claude/projects/<slug>. It uses os.UserHomeDir() + transcript.ClaudeProjectDir —
// the same derivation as SessionLog and conversationDest — rather than s.Root,
// so it stays correct when HOME and Root differ.
func (s *Service) claudeConvDir(workspaceID string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = s.Root // best-effort fallback if HOME is unavailable
	}
	return transcript.ClaudeProjectDir(home, s.worktreePath(workspaceID))
}

// userTurnCount totals the user messages Claude has recorded across the *.jsonl
// files in dir (0 if it doesn't exist yet). We count user turns specifically
// rather than total bytes so an in-flight assistant reply — which also grows the
// log — can't be mistaken for our prompt being accepted. Each conversation entry
// is one JSON line; parse its `type` field (rather than substring-matching
// `"type":"user"`, which can appear inside an assistant turn's content).
//
// The files of other chats (skip, by session id) aren't counted: they share
// the folder.
func userTurnCount(dir string, skip map[string]bool) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") || skip[strings.TrimSuffix(e.Name(), ".jsonl")] {
			continue
		}
		count += fileUserTurns(filepath.Join(dir, e.Name()))
	}
	return count
}

// fileUserTurns counts the user messages in one conversation file (0 if it
// doesn't exist yet), and the prompts queued in it: one sent while Claude is
// mid-turn is queued, recorded as an enqueue at once but as a user message
// only when the turn takes it up, which a long tool call can put off for
// minutes. Counting both only ever grows the count, which is all a send
// compares.
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
			Type      string `json:"type"`
			Operation string `json:"operation"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if rec.Type == "user" || (rec.Type == "queue-operation" && rec.Operation == "enqueue") {
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
	return userTurnCount(s.claudeConvDir(workspaceID), s.chatSessionIDs(workspaceID))
}

// sessionLog returns the current Claude JSONL path for a workspace, or "" if
// Claude hasn't written anything yet. Claude Code stores per-project logs at
// ~/.claude/projects/<slug>/<sessionId>.jsonl (see transcript.ClaudeSlug). A worktree is
// the session's own, and --continue reuses its file, so "newest jsonl" ==
// "current session"; an in-place session's conversation is named by id.
func (a claudeAgent) sessionLog(workspaceID string) string {
	s := a.s
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := transcript.ClaudeProjectDir(home, s.worktreePath(workspaceID))
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
	// Not another chat's: the session's chats share its worktree.
	skip := s.chatSessionIDs(workspaceID)
	var newest string
	var newestMod time.Time
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" || skip[strings.TrimSuffix(e.Name(), ".jsonl")] {
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

// withoutFlag is argv less a flag and the value after it.
func withoutFlag(argv []string, flag string) []string {
	out := make([]string, 0, len(argv))
	for i := 0; i < len(argv); i++ {
		if argv[i] == flag && i+1 < len(argv) {
			i++
			continue
		}
		out = append(out, argv[i])
	}
	return out
}

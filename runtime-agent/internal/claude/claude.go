// Package claude launches the real Claude Code CLI. Runtime never wraps or
// proxies Claude — it starts `claude` in the workspace's tmux session and lets
// it talk to Anthropic directly with the injected session credentials.
package claude

import (
	"fmt"
	"strings"
)

// PermissionMode is the `--permission-mode` a session launches with.
type PermissionMode string

const (
	// Bypass is the Runtime Computer default. The box is disposable and holds
	// nothing of the user's, so an autonomous session ("work while the laptop is
	// closed") is the point. Claude refuses it as root (surfaced in Spike 4),
	// which is why runtime-computer-v1 runs as the `runtime` user.
	Bypass PermissionMode = "bypassPermissions"
	// AcceptEdits auto-approves file edits and asks before shell commands. The
	// desktop shell launches local sessions with it: there the machine is the
	// user's own, with their keys and credentials on it.
	AcceptEdits PermissionMode = "acceptEdits"
	// Default asks before every edit and command.
	Default PermissionMode = "default"
	// Plan lets Claude read and plan but not change anything.
	Plan PermissionMode = "plan"
)

// ParsePermissionMode validates a requested mode. Empty stays empty — no mode
// was asked for — and the workspace service picks one when Claude launches, so
// the default is decided in one place (workspace.Service.permissionMode).
func ParsePermissionMode(raw string) (PermissionMode, error) {
	switch mode := PermissionMode(raw); mode {
	case "", Bypass, AcceptEdits, Default, Plan:
		return mode, nil
	default:
		return "", fmt.Errorf("unknown permission mode %q", raw)
	}
}

// Command returns the argv for launching an interactive Claude Code session.
//
// orientation, when non-empty, is injected via --append-system-prompt so Claude
// knows it's running inside a Runtime Workspace (see Orientation).
func Command(mode PermissionMode, orientation string) []string {
	return withOrientation([]string{"claude", "--permission-mode", string(mode)}, orientation)
}

// ContinueCommand resumes the most recent session in the workspace, used on
// resume after the process exited or the box restarted.
func ContinueCommand(mode PermissionMode, orientation string) []string {
	return withOrientation([]string{"claude", "--continue", "--permission-mode", string(mode)}, orientation)
}

// SessionCommand starts a conversation under a known id, so its transcript is
// <id>.jsonl however many other conversations share the working directory.
func SessionCommand(mode PermissionMode, sessionID, orientation string) []string {
	return withOrientation([]string{"claude", "--session-id", sessionID, "--permission-mode", string(mode)}, orientation)
}

// ResumeCommand continues the conversation with that id (in the same
// transcript: Claude forks a new id only when asked to).
func ResumeCommand(mode PermissionMode, sessionID, orientation string) []string {
	return withOrientation([]string{"claude", "--resume", sessionID, "--permission-mode", string(mode)}, orientation)
}

// WithModel adds --model, so the session runs that model without touching the
// user's default: /model inside Claude saves its pick as the default for every
// new session, which on a user's own Mac would change their Claude Code too.
// An empty model keeps Claude's own choice.
func WithModel(argv []string, model string) []string {
	if model == "" {
		return argv
	}
	return append(argv, "--model", model)
}

// ValidModel accepts a model as Claude's --model takes it: an alias ("opus"),
// a full name ("claude-opus-4-5-20250101", "claude-opus-4-5[1m]"), or a
// gateway's slug ("z-ai/glm-5.3"). Nothing that could read as another flag.
func ValidModel(model string) bool {
	if model == "" || len(model) > 100 || model[0] == '-' {
		return false
	}
	for _, r := range model {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("-._:/[]~", r):
		default:
			return false
		}
	}
	return true
}

// withOrientation appends --append-system-prompt when there's an orientation to
// inject. We *append* rather than replace so Claude's built-in defaults and the
// repo's auto-loaded CLAUDE.md still apply — the orientation is the floor of the
// prompt stack, not a ceiling.
func withOrientation(argv []string, orientation string) []string {
	if orientation == "" {
		return argv
	}
	return append(argv, "--append-system-prompt", orientation)
}

// Orientation renders the Outrunner orientation system prompt injected at
// session start via --append-system-prompt. It is the floor of the prompt
// layering (Outrunner orientation → repo CLAUDE.md → owner → task): it tells
// the agent where it is running and the workspace rules. Coding style and
// project conventions deliberately belong in CLAUDE.md, not here.
//
// worktree is the absolute path of the workspace's git worktree (the agent's
// working directory). baseBranch is the branch pull requests target, e.g.
// "main". Both may be empty after a box restart that lost the recorded facts:
// an empty worktree degrades to a generic phrase, and an empty baseBranch omits
// the target-branch guidance entirely rather than naming a bogus base.
func Orientation(worktree, baseBranch string) string {
	workingDir := worktree
	if workingDir == "" {
		workingDir = "workspace"
	}
	screenshotPath := ".context/screenshot.png"
	if worktree != "" {
		screenshotPath = worktree + "/.context/screenshot.png"
	}

	var b strings.Builder
	b.WriteString("You are working inside Outrunner, a Mac app that lets the user run many coding agents in parallel.\n")
	fmt.Fprintf(&b, "Your work should take place in the %s directory (unless otherwise directed), which has been set up for you to work in.\n", workingDir)
	b.WriteString("Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.\n")
	if baseBranch != "" {
		fmt.Fprintf(&b, "The target branch for this workspace is origin/%s. Use this for actions like diffing (git diff origin/%s...) or creating PRs (gh pr create --base %s).\n", baseBranch, baseBranch, baseBranch)
	}
	b.WriteString("\nDo not rename the current branch unless the user explicitly tells you to do so.\n")
	b.WriteString("\nBy default, the user will only see the last message that you send before stopping. Include all essential information in the last message. The intermediate messages will be collapsed and accessible by the user but not displayed by default.\n")
	fmt.Fprintf(&b, "\nSave screenshots under .context/ and embed them inline in the final response using Markdown image syntax, for example ![Screenshot](<%s>).\n", screenshotPath)
	b.WriteString("\nIf the user asks you to work on several unrelated tasks, you can suggest they start new workspaces.\n")
	b.WriteString("Sometimes the user might send you a message they meant to send in a different workspace or a different chat. If something doesn't make sense in the context of your work, just ask.\n")
	b.WriteString("If the user asks for help with Outrunner, you can ask them to go to \"Help -> Send Feedback\" to get in touch with our team.")
	return b.String()
}

// SessionEnv builds the environment for a Claude session. The Anthropic
// credential is held in agent memory and injected here only — never written to
// disk on the box, never logged.
func SessionEnv(base []string, anthropicToken string) []string {
	env := append([]string{}, base...)
	// Suppress Claude's startup network work (auto-update, marketplace install,
	// non-essential telemetry). On a fresh box that work takes several seconds,
	// during which the TUI silently drops any prompt submitted into it — the
	// cause of "I typed but Claude never answered" right after a workspace opens.
	// It also removes the "Auto-update failed" / "marketplace" noise from the
	// pane. The essential model API traffic is unaffected.
	env = append(env,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_AUTOUPDATER=1",
	)
	if anthropicToken != "" {
		env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+anthropicToken)
	}
	return env
}

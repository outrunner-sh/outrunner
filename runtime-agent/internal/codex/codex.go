// Package codex launches the real OpenAI Codex CLI, the second agent a session
// can run. Like Claude it runs in the workspace's tmux session and talks to its
// provider itself: Runtime only starts it, reads its screen, and translates its
// conversation log into the record shape Claude's has.
package codex

import (
	"fmt"
	"strings"

	"runtime-agent/internal/claude"
)

// InstallHint is how to get the Codex CLI a session needs: the version this
// agent's launch flags and transcript reading were checked against.
const InstallHint = "npm install -g @openai/codex@0.146.0"

// Command is the argv that launches Codex in a session, or with sessionID
// continues that conversation (`codex resume <id>` appends to the same
// rollout). model is -m, and effort its model_reasoning_effort; empty keeps
// Codex's default for either. instructions (the
// orientation) are added to Codex's own developer instructions, never in place
// of them.
//
// The update check is off: a launch must never stop at an offer to upgrade,
// which the readiness wait doesn't answer and the first prompt would.
func Command(mode claude.PermissionMode, sessionID, model, effort, instructions string) []string {
	argv := []string{"codex"}
	if sessionID != "" {
		argv = append(argv, "resume", sessionID)
	}
	if model != "" {
		argv = append(argv, "-m", model)
	}
	if effort != "" {
		argv = append(argv, "-c", "model_reasoning_effort="+TOMLString(effort))
	}
	argv = append(argv, "-c", "check_for_update_on_startup=false")
	if instructions != "" {
		argv = append(argv, "-c", "developer_instructions="+TOMLString(instructions))
	}
	return append(argv, permissionArgs(mode)...)
}

// permissionArgs are Codex's nearest equivalent of each of Claude's permission
// modes: a sandbox for what commands may touch, and an approval policy for when
// Codex asks first. bypassPermissions is Codex's own "no sandbox, no
// questions", for a disposable Runtime Computer only (the workspace service
// refuses it in a folder of the user's). An unknown mode gets the strictest
// that still edits, rather than more than was asked for.
func permissionArgs(mode claude.PermissionMode) []string {
	switch mode {
	case claude.Bypass:
		return []string{"--dangerously-bypass-approvals-and-sandbox"}
	case claude.AcceptEdits:
		return []string{"-s", "workspace-write", "-a", "on-request"}
	case claude.Plan:
		return []string{"-s", "read-only", "-a", "on-request"}
	default: // claude.Default
		return []string{"-s", "workspace-write", "-a", "untrusted"}
	}
}

// TOMLString renders s as a TOML basic string, the form a `-c key=value`
// override parses its value as. Backslashes, quotes and control characters
// are escaped, so a multi-line orientation stays one value: unescaped, a
// newline would end it and Codex would read the rest as a raw string.
func TOMLString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			// TOML allows no other control character in a basic string.
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&b, `\u%04X`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

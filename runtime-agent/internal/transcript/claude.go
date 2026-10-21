// Package transcript knows where coding agents keep their conversations on
// disk and how to read what a file says about itself: Claude Code's per-folder
// JSONL logs and Codex's rollouts. The box's sessions, Restore and the import
// of a user's local sessions all find transcripts through it.
package transcript

import (
	"path/filepath"
	"strconv"
	"unicode/utf16"
)

// ClaudeProjectDir is the directory Claude Code keeps a working directory's
// conversation logs in. Claude names it after its real working directory, so
// symlinks are resolved first: on macOS /var and /tmp live under /private, and
// a symlinked checkout or home is common. A path that does not exist yet is
// used as given.
func ClaudeProjectDir(home, worktree string) string {
	if resolved, err := filepath.EvalSymlinks(worktree); err == nil {
		worktree = resolved
	}
	return filepath.Join(home, ".claude", "projects", ClaudeSlug(worktree))
}

// ClaudeSlug encodes a filesystem path the way Claude Code names its
// per-project JSONL directory (read from Claude Code 2.1's bundle). It runs
// `path.replace(/[^a-zA-Z0-9]/g, "-")` on a JavaScript string, so the unit is a
// UTF-16 code unit, not a byte or a rune: "é" becomes one '-', an emoji two.
// A slug over slugMax units is cut there and suffixed with '-' and the
// base-36 absolute value of the path's 32-bit Java-style string hash.
func ClaudeSlug(path string) string {
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
	if len(b) <= slugMax {
		return string(b)
	}
	abs := int64(hash)
	if abs < 0 {
		abs = -abs
	}
	return string(b[:slugMax]) + "-" + strconv.FormatInt(abs, 36)
}

// slugMax is the longest slug Claude Code keeps whole.
const slugMax = 200

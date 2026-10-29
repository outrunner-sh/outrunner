package workspace

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// What every session on this computer reads besides its orientation: the
// learnings its user and org keep in Outrunner (lib/runtime/agent-context.ts
// in the web app), as Markdown. Claude reads ~/.claude/CLAUDE.md and Codex
// ~/.codex/AGENTS.md (copied into a session's own Codex home, copyAgentsMD)
// at every launch, so the Markdown goes in each, in a block of its own
// between two markers: the rest of the file is the user's (their import's,
// agentconfig.go, or their own) and is left exactly as it was. The block is
// kept beside them too, so an import that replaces either file gets it back.

// ErrInvalidAgentContext is Markdown the computer can't take.
var ErrInvalidAgentContext = errors.New("invalid agent context")

// maxAgentContextBytes bounds the block: it is in every turn's prompt.
const maxAgentContextBytes = 64 << 10

const (
	agentContextStart = "<!-- outrunner:begin — kept by Outrunner (Settings → Learnings); changes here are replaced -->"
	agentContextEnd   = "<!-- outrunner:end -->"
)

func agentContextStatePath(home string) string {
	return filepath.Join(home, ".outrunner", "agent-context.md")
}

// agentContextFiles are the files the block goes in.
func agentContextFiles(home string) []string {
	return []string{filepath.Join(home, ".claude", "CLAUDE.md"), filepath.Join(home, ".codex", "AGENTS.md")}
}

// SetAgentContext puts content in the block of every file it goes in,
// replacing the block an earlier call put there; empty removes it.
func (s *Service) SetAgentContext(content string) error {
	content = strings.TrimSpace(content)
	if len(content) > maxAgentContextBytes || strings.ContainsRune(content, 0) {
		return fmt.Errorf("%w: too large", ErrInvalidAgentContext)
	}
	if strings.Contains(content, agentContextStart) || strings.Contains(content, agentContextEnd) {
		return fmt.Errorf("%w: it holds the block's markers", ErrInvalidAgentContext)
	}
	home, err := agentConfigHome()
	if err != nil {
		return err
	}
	agentConfigMu.Lock()
	defer agentConfigMu.Unlock()
	state := agentContextStatePath(home)
	if content == "" {
		if err := os.Remove(state); err != nil && !os.IsNotExist(err) {
			return err
		}
	} else if err := writeKeysFile(state, content+"\n"); err != nil {
		return err
	}
	return applyAgentContext(home)
}

// applyAgentContext puts the kept block in each file, as it is now. Called
// with agentConfigMu held: after SetAgentContext, and after an import
// (SetAgentConfig) that may have put the user's own file in its place.
func applyAgentContext(home string) error {
	data, err := os.ReadFile(agentContextStatePath(home))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	content := strings.TrimSpace(string(data))
	for _, path := range agentContextFiles(home) {
		if err := withAgentContextBlock(path, content); err != nil {
			// One unwritable agent file must not stop the other file or make
			// an agent-config import fail before its MCP settings are installed.
			log.Printf("apply Outrunner agent context to %s: %v", path, err)
		}
	}
	return nil
}

// withAgentContextBlock rewrites one file with content as its block (or
// none), the rest as it was. A file that held nothing but the block is
// removed with it, and none is made for an empty block.
func withAgentContextBlock(path, content string) error {
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	existed := err == nil
	own := withoutAgentContextBlock(string(data))
	next := own
	if content != "" {
		block := agentContextStart + "\n" + content + "\n" + agentContextEnd + "\n"
		if strings.TrimSpace(own) == "" {
			next = block
		} else {
			next = strings.TrimRight(own, "\n") + "\n\n" + block
		}
	}
	if next == string(data) {
		return nil
	}
	if strings.TrimSpace(next) == "" && !isSymlink(path) {
		if existed {
			return os.Remove(path)
		}
		return nil
	}
	// Written where the file really is, with its own mode: a CLAUDE.md that
	// links into the user's dotfiles stays a link, and its target is what
	// changes; an owner-only one stays owner-only.
	mode := os.FileMode(0o644)
	writePath := path
	if existed {
		if target, err := filepath.EvalSymlinks(path); err == nil {
			writePath = target
		}
		if info, err := os.Stat(writePath); err == nil {
			mode = info.Mode().Perm()
		}
	}
	if err := writeAgentContextFile(writePath, next, mode); err == nil {
		return nil
	} else if writePath == path {
		return err
	} else {
		// Dotfile targets can be read-only (for example, in /nix/store).
		// Keep the old import behaviour in that case by replacing the link.
		if strings.TrimSpace(next) == "" {
			return os.Remove(path)
		}
		return writeAgentContextFile(path, next, 0o644)
	}
}

func isSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

func writeAgentContextFile(path, text string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".outrunner-tmp"
	if err := os.WriteFile(tmp, []byte(text), mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// withoutAgentContextBlock is a file's text with any block taken out, and
// the blank lines that set it apart from the user's own; the user's text is
// otherwise untouched. A start marker with no end (a file cut short) takes
// the rest of the file: it is the block's.
func withoutAgentContextBlock(text string) string {
	for {
		start := strings.Index(text, agentContextStart)
		if start < 0 {
			return text
		}
		before := text[:start]
		after := ""
		if end := strings.Index(text[start:], agentContextEnd); end >= 0 {
			after = strings.TrimLeft(text[start+end+len(agentContextEnd):], "\n")
		}
		if after == "" {
			before = strings.TrimRight(before, "\n")
			if before != "" {
				before += "\n"
			}
		}
		text = before + after
	}
}

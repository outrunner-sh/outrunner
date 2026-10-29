package workspace

import (
	"archive/tar"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// The block goes after the user's own CLAUDE.md and AGENTS.md, is replaced
// in place by the next, and comes out leaving the user's text exactly as it
// was; a file that was only the block goes with it.
func TestAgentContextIsABlockBesideTheUsersOwnText(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := NewService(t.TempDir())
	claudeMD := filepath.Join(home, ".claude", "CLAUDE.md")
	agentsMD := filepath.Join(home, ".codex", "AGENTS.md")
	writeTestFile(t, claudeMD, "# Mine\n\nBe brief.\n")

	if err := s.SetAgentContext("# Outrunner learnings\n\nUse Conventional Commits."); err != nil {
		t.Fatal(err)
	}
	want := "# Mine\n\nBe brief.\n\n" + agentContextStart + "\n# Outrunner learnings\n\nUse Conventional Commits.\n" + agentContextEnd + "\n"
	if got := readFile(claudeMD); got != want {
		t.Errorf("CLAUDE.md = %q, want %q", got, want)
	}
	if got := readFile(agentsMD); !strings.HasPrefix(got, agentContextStart) || !strings.Contains(got, "Use Conventional Commits.") {
		t.Errorf("AGENTS.md = %q, want the block alone", got)
	}

	// The user edits their part; the next block replaces the last, theirs kept.
	writeTestFile(t, claudeMD, strings.Replace(readFile(claudeMD), "Be brief.", "Be briefer.", 1))
	if err := s.SetAgentContext("Run pnpm check before a PR."); err != nil {
		t.Fatal(err)
	}
	got := readFile(claudeMD)
	if strings.Count(got, agentContextStart) != 1 || strings.Contains(got, "Conventional") || !strings.Contains(got, "Be briefer.") ||
		!strings.Contains(got, "Run pnpm check") {
		t.Errorf("CLAUDE.md after a second block = %q", got)
	}

	if err := s.SetAgentContext(""); err != nil {
		t.Fatal(err)
	}
	if got := readFile(claudeMD); got != "# Mine\n\nBe briefer.\n" {
		t.Errorf("CLAUDE.md without the block = %q", got)
	}
	if fileExists(agentsMD) {
		t.Error("AGENTS.md that held only the block is still there")
	}
	if fileExists(agentContextStatePath(home)) {
		t.Error("the kept block is still there")
	}
}

// An import that replaces CLAUDE.md gets the block back after it.
func TestAgentContextOutlivesAnImport(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := NewService(t.TempDir())
	if err := s.SetAgentContext("Use Conventional Commits."); err != nil {
		t.Fatal(err)
	}
	archive, digest := configArchive(t, tarEntry{name: ".claude/", kind: tar.TypeDir}, tarEntry{name: ".claude/CLAUDE.md", body: "be brief\n"})
	if err := s.SetAgentConfig(context.Background(), AgentConfigRequest{Version: "v1", URL: serve(t, archive), SHA256: digest}); err != nil {
		t.Fatal(err)
	}
	got := readFile(filepath.Join(home, ".claude", "CLAUDE.md"))
	if !strings.HasPrefix(got, "be brief\n\n"+agentContextStart) || !strings.Contains(got, "Use Conventional Commits.") {
		t.Errorf("CLAUDE.md after an import = %q", got)
	}
}

// Markdown past the bound, or holding the markers (which would end the block
// early, and leave the rest as the user's), is refused.
func TestAgentContextRefusesWhatCantBeABlock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	for _, content := range []string{strings.Repeat("x", maxAgentContextBytes+1), "a\n" + agentContextEnd + "\nb", "nul\x00"} {
		if err := s.SetAgentContext(content); !errors.Is(err, ErrInvalidAgentContext) {
			t.Errorf("SetAgentContext(%.20q) = %v, want refused", content, err)
		}
	}
}

// A block cut short (no end marker) takes the rest of the file, and the
// user's text before it is kept.
func TestWithoutAgentContextBlock(t *testing.T) {
	for in, want := range map[string]string{
		"mine\n": "mine\n",
		"mine\n\n" + agentContextStart + "\nx\n" + agentContextEnd + "\n": "mine\n",
		agentContextStart + "\nx\n" + agentContextEnd + "\nafter\n":       "after\n",
		"mine\n" + agentContextStart + "\nx":                              "mine\n",
		agentContextStart + "\nx\n" + agentContextEnd + "\n":              "",
	} {
		if got := withoutAgentContextBlock(in); got != want {
			t.Errorf("withoutAgentContextBlock(%q) = %q, want %q", in, got, want)
		}
	}
}

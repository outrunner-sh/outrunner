package transcript

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeSlugMatchesClaudeCode(t *testing.T) {
	// Real directory names Claude Code created on a Mac.
	for path, want := range map[string]string{
		"/home/daytona/workspaces/abc-123":        "-home-daytona-workspaces-abc-123",
		"/Users/ada/.outrunner/workspaces/x":      "-Users-ada--outrunner-workspaces-x",
		"/Users/ada/Desktop/personal/new project": "-Users-ada-Desktop-personal-new-project",
		"/Users/ada/Desktop - MacBook Air (3)/m":  "-Users-ada-Desktop---MacBook-Air--3--m",
		// Computed with the slug function from Claude Code 2.1.228's bundle: one
		// '-' per UTF-16 code unit, so "é" and each CJK character give one and an
		// emoji (a surrogate pair) two.
		"/Users/ada/café":    "-Users-ada-caf-",
		"/Users/ada/日本語/app": "-Users-ada-----app",
		"/Users/ada/😀 x":     "-Users-ada----x",
		// Over 200 characters: cut, then a hash of the whole path.
		"/Users/ada/" + strings.Repeat("projects/", 22) + "café 😀": "-Users-ada-" +
			strings.Repeat("projects-", 21) + "-22n29x",
	} {
		if got := ClaudeSlug(path); got != want {
			t.Errorf("ClaudeSlug(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestClaudeProjectDirResolvesSymlinks(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	// Claude runs in the real directory, so the log lives under its name.
	want := filepath.Join("/h", ".claude", "projects", ClaudeSlug(resolved))
	if got := ClaudeProjectDir("/h", link); got != want {
		t.Errorf("ClaudeProjectDir(link) = %q, want %q", got, want)
	}
}

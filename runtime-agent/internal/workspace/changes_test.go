package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseChangedFiles(t *testing.T) {
	// porcelain v1 -z: " M" keeps its leading space, and a rename is followed by
	// its original name as a separate field.
	out := " M src/a.ts\x00?? new.txt\x00A  added.go\x00 D gone.md\x00R  to.ts\x00from.ts\x00"
	got := parseChangedFiles(out)
	want := map[string]string{"src/a.ts": "modified", "new.txt": "untracked", "added.go": "added", "gone.md": "deleted", "to.ts": "renamed"}
	if len(got) != len(want) {
		t.Fatalf("parsed %d files, want %d: %+v", len(got), len(want), got)
	}
	for _, f := range got {
		if want[f.Path] != f.Status {
			t.Errorf("%s: status %q, want %q", f.Path, f.Status, want[f.Path])
		}
	}
}

func TestSafeRelativePath(t *testing.T) {
	for _, ok := range []string{"a.txt", "src/a.ts", "dir with space/f"} {
		if !safeRelativePath(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../../b", ":(glob)*", "a//b", "a\x00b", `..\x`} {
		if safeRelativePath(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestLimitTextKeepsUTF8Whole(t *testing.T) {
	got := limitText("ab✓✓", 4) // the cut would land inside the first ✓
	if !strings.HasPrefix(got, "ab\n") || !strings.Contains(got, "truncated") {
		t.Errorf("limitText = %q", got)
	}
}

func TestChangesAndDiffOfALocalWorktree(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-diff", Branch: "runtime/diff", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "notes.txt"), []byte("n\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	files, err := s.Changes(context.Background(), "ws-diff")
	if err != nil {
		t.Fatalf("Changes: %v", err)
	}
	statuses := map[string]string{}
	for _, f := range files {
		statuses[f.Path] = f.Status
	}
	if statuses["README.md"] != "modified" || statuses["notes.txt"] != "untracked" || len(files) != 2 {
		t.Fatalf("Changes = %+v", files)
	}

	diff, err := s.FileDiff(context.Background(), "ws-diff", "README.md")
	if err != nil || !strings.Contains(diff, "+world") {
		t.Errorf("FileDiff(README.md) = %q, %v", diff, err)
	}
	if diff, _ := s.FileDiff(context.Background(), "ws-diff", "notes.txt"); !strings.Contains(diff, "untracked") {
		t.Errorf("untracked diff = %q", diff)
	}
	if _, err := s.FileDiff(context.Background(), "ws-diff", "../README.md"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("traversal: err = %v, want ErrInvalidPath", err)
	}
	if _, err := s.FileDiff(context.Background(), "ws-diff", "unchanged.txt"); !errors.Is(err, ErrNotChanged) {
		t.Errorf("unchanged file: err = %v, want ErrNotChanged", err)
	}

	// Claude often stages its work: a staged file's diff must not come back empty.
	run(t, worktree, "add", "notes.txt", "README.md")
	if diff, _ := s.FileDiff(context.Background(), "ws-diff", "notes.txt"); !strings.Contains(diff, "+n") {
		t.Errorf("staged new file diff = %q, want its content", diff)
	}
	if diff, _ := s.FileDiff(context.Background(), "ws-diff", "README.md"); !strings.Contains(diff, "+world") {
		t.Errorf("staged edit diff = %q, want the change", diff)
	}

	// The staged edit stays, but the working copy goes back to HEAD: still
	// listed as changed, so its diff must not be empty.
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	diff, err = s.FileDiff(context.Background(), "ws-diff", "README.md")
	if err != nil || !strings.Contains(diff, "+world") || !strings.Contains(diff, "-world") {
		t.Errorf("staged-then-reverted diff = %q, %v; want the staged edit and its undoing", diff, err)
	}
}

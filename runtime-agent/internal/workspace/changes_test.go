package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"runtime-agent/internal/protocol"
)

func TestParseChangedFiles(t *testing.T) {
	// -z output: a rename or copy carries its old and new names as separate
	// fields; in numstat its path field is empty. A binary file counts "-", and
	// a path may hold a tab.
	nameStatus := "M\x00src/a.ts\x00A\x00logo.png\x00D\x00gone.md\x00R087\x00from.ts\x00to.ts\x00C75\x00orig.ts\x00copy.ts\x00M\x00tab\there.ts\x00"
	numstat := "3\t1\tsrc/a.ts\x00-\t-\tlogo.png\x000\t9\tgone.md\x00" +
		"2\t1\t\x00from.ts\x00to.ts\x004\t0\t\x00orig.ts\x00copy.ts\x005\t0\ttab\there.ts\x00"
	// gone.md is out of the index but still on disk: listed once.
	untracked := "new.txt\x00gone.md\x00"
	got := parseChangedFiles(nameStatus, numstat, untracked)
	want := []protocol.ChangedFile{
		{Path: "src/a.ts", Status: "modified", Additions: 3, Deletions: 1},
		{Path: "logo.png", Status: "added"},
		{Path: "gone.md", Status: "deleted", Deletions: 9},
		{Path: "to.ts", Status: "renamed", Additions: 2, Deletions: 1},
		{Path: "copy.ts", Status: "added", Additions: 4},
		{Path: "tab\there.ts", Status: "modified", Additions: 5},
		{Path: "new.txt", Status: "untracked"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseChangedFiles =\n%+v\nwant\n%+v", got, want)
	}

	// `git grep -c -z` prints "path\0count\n"; a path may hold a newline.
	lines := parseLineCounts("a.txt\x002\nsub/new\nline.txt\x003\ntab\there.txt\x001\n")
	if want := map[string]int{"a.txt": 2, "sub/new\nline.txt": 3, "tab\there.txt": 1}; !reflect.DeepEqual(lines, want) {
		t.Errorf("parseLineCounts = %v, want %v", lines, want)
	}

	var many strings.Builder
	for i := 0; i <= maxChangedFiles; i++ {
		fmt.Fprintf(&many, "f%d\x00", i)
	}
	if got := parseChangedFiles("", "", many.String()); len(got) != maxChangedFiles {
		t.Errorf("parsed %d files, want the cap of %d", len(got), maxChangedFiles)
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
	// An untracked text file counts its lines; an untracked binary stays at 0.
	if err := os.WriteFile(filepath.Join(worktree, "blob.bin"), []byte{0, '\n', 0, '\n'}, 0o644); err != nil {
		t.Fatal(err)
	}

	files, err := s.Changes(context.Background(), "ws-diff")
	want := []protocol.ChangedFile{
		{Path: "README.md", Status: "modified", Additions: 1},
		{Path: "blob.bin", Status: "untracked"},
		{Path: "notes.txt", Status: "untracked", Additions: 1},
	}
	if err != nil || !reflect.DeepEqual(files, want) {
		t.Fatalf("Changes = %+v, %v; want %+v", files, err, want)
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

	// The staged edit stays, but the working copy goes back to the base: no
	// change is left, so the file drops out rather than showing an empty patch.
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FileDiff(context.Background(), "ws-diff", "README.md"); !errors.Is(err, ErrNotChanged) {
		t.Errorf("staged-then-reverted: err = %v, want ErrNotChanged", err)
	}

	// Committed work stays in the change set, with its line counts, alongside
	// what is not committed yet.
	run(t, worktree, "add", "README.md")
	run(t, worktree, "commit", "--quiet", "-m", "notes")
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, err = s.Changes(context.Background(), "ws-diff")
	want = []protocol.ChangedFile{
		{Path: "README.md", Status: "modified", Additions: 1},
		{Path: "notes.txt", Status: "added", Additions: 1},
		{Path: "blob.bin", Status: "untracked"},
	}
	if err != nil || !reflect.DeepEqual(files, want) {
		t.Fatalf("Changes after a commit = %+v, %v; want %+v", files, err, want)
	}
	if diff, err := s.FileDiff(context.Background(), "ws-diff", "notes.txt"); err != nil || !strings.Contains(diff, "+n") {
		t.Errorf("committed file diff = %q, %v; want its content", diff, err)
	}

	// A base that no longer resolves falls back to HEAD: only what is not
	// committed yet.
	facts, _ := s.getFacts("ws-diff")
	facts.BaseBranch = "no-such-branch"
	s.setFacts("ws-diff", facts)
	files, err = s.Changes(context.Background(), "ws-diff")
	uncommitted := []protocol.ChangedFile{want[0], want[2]}
	if err != nil || !reflect.DeepEqual(files, uncommitted) {
		t.Errorf("Changes without a base = %+v, %v; want %+v", files, err, uncommitted)
	}
}

func TestBigFilesInAChangeSetAreLeftUnreadOrCut(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-big", Branch: "runtime/big", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	lines := func(bytes int) []byte { // over `bytes` long
		const line = "a line of generated text, much like any other\n"
		return []byte(strings.Repeat(line, bytes/len(line)+1))
	}
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(worktree, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// An untracked file over the counting limit isn't read for its lines (git
	// would read it whole on every look at the panel); a small one is.
	write("small.txt", []byte("1\n2\n3\n"))
	write("server.log", lines(maxCountedFileBytes+1))
	files, err := s.Changes(context.Background(), "ws-big")
	want := []protocol.ChangedFile{
		{Path: "server.log", Status: "untracked"},
		{Path: "small.txt", Status: "untracked", Additions: 3},
	}
	if err != nil || !reflect.DeepEqual(files, want) {
		t.Fatalf("Changes = %+v, %v; want %+v", files, err, want)
	}

	// A file too big to diff says so, rather than git holding it in memory
	// several times over; one under that limit comes back cut to the cap.
	write("dump.sql", lines(maxDiffedFileBytes+1))
	write("generated.ts", lines(3*maxDiffBytes))
	run(t, worktree, "add", "dump.sql", "generated.ts")
	if diff, err := s.FileDiff(context.Background(), "ws-big", "dump.sql"); err != nil || !strings.Contains(diff, "too large") {
		t.Errorf("FileDiff(dump.sql) = %.80q, %v; want it called too large", diff, err)
	}
	diff, err := s.FileDiff(context.Background(), "ws-big", "generated.ts")
	if err != nil || !strings.Contains(diff, "+a line of generated text") || !strings.HasSuffix(diff, "truncated by Runtime …") {
		t.Errorf("FileDiff(generated.ts) = %.80q…, %v; want its diff, cut", diff, err)
	}
	if len(diff) > maxDiffBytes+100 {
		t.Errorf("FileDiff(generated.ts) is %d bytes, over the cap", len(diff))
	}

	// A deleted file is measured as it was.
	run(t, worktree, "commit", "--quiet", "-m", "big")
	run(t, worktree, "rm", "--quiet", "dump.sql")
	run(t, worktree, "commit", "--quiet", "-m", "gone")
	if size := s.diffedSize(context.Background(), worktree, "HEAD~1", "dump.sql"); size <= maxDiffedFileBytes {
		t.Errorf("a deleted file's size = %d, want its size at the base", size)
	}
}

func TestGitCappedStopsReadingAtItsLimit(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	out, err := s.gitCapped(context.Background(), repo, 10, "log", "--format=%H")
	if err != nil || len(out) != 11 {
		t.Errorf("gitCapped = %q, %v; want the limit and one byte more", out, err)
	}
	if out, err := s.gitCapped(context.Background(), repo, 1<<20, "rev-parse", "HEAD"); err != nil || len(strings.TrimSpace(out)) != 40 {
		t.Errorf("gitCapped under its limit = %q, %v", out, err)
	}
	if _, err := s.gitCapped(context.Background(), repo, 10, "no-such-command"); err == nil {
		t.Error("a failing git command didn't fail")
	}
}

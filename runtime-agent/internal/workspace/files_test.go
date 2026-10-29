package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"testing"
	"time"
)

func TestFilesListTheChangedOnesFirstNewestFirst(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-files", Branch: "runtime/files", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	write := func(name, body string, at time.Time) {
		t.Helper()
		path := filepath.Join(worktree, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	write("src/old.ts", "a\n", now.Add(-time.Hour))
	write("README.md", "hello\nworld\n", now) // tracked, edited last
	write(".gitignore", "*.log\n", now.Add(-2*time.Hour))
	write("debug.log", "ignored\n", now)

	got, err := s.Files(context.Background(), "ws-files")
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if got.Changed != 3 || !reflect.DeepEqual(got.Files[:3], []string{"README.md", "src/old.ts", ".gitignore"}) {
		t.Errorf("changed = %d, first %q; want the three changed files, newest first", got.Changed, got.Files)
	}
	for _, path := range got.Files {
		if path == "debug.log" {
			t.Error("an ignored file was offered")
		}
	}
	if _, err := s.Files(context.Background(), "nope"); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("unknown workspace = %v", err)
	}
}

func TestAListingIsCappedAndSaysSo(t *testing.T) {
	all := make([]string, 0, MaxListedFiles+5)
	for i := 0; i < MaxListedFiles+5; i++ {
		all = append(all, "f"+strconv.Itoa(i))
	}
	got := listing([]string{"f3", "new.ts"}, all)
	if len(got.Files) != MaxListedFiles || !got.Truncated || got.Changed != 2 || got.Files[0] != "f3" {
		t.Errorf("listing = %d files (changed %d, truncated %v, first %q)", len(got.Files), got.Changed, got.Truncated, got.Files[0])
	}
	// A changed file is listed once, among the changed.
	seen := 0
	for _, path := range got.Files {
		if path == "f3" {
			seen++
		}
	}
	if seen != 1 {
		t.Errorf("f3 listed %d times", seen)
	}
}

func TestAFolderThatIsntARepositoryIsWalked(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "src/b.go", "node_modules/x/index.js", ".cache/y"} {
		path := filepath.Join(root, name)
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		_ = os.WriteFile(path, []byte("x"), 0o644)
	}
	got := walkFiles(root)
	if !reflect.DeepEqual(got, []string{"a.txt", "src/b.go"}) {
		t.Errorf("walk = %q, want the files past node_modules and dot folders", got)
	}
}

// A session of several repositories with one checkout git can't read
// (mid-clone): the others are still listed; none read at all is an error.
func TestFilesListTheCheckoutsThatCanBeRead(t *testing.T) {
	isolateGit(t)
	s := NewService(t.TempDir())
	if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: "ws-multi", Branch: "b", BaseBranch: "main", RepoPath: newCheckout(t)}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	worktree := s.worktreePath("ws-multi")
	web := filepath.Join(worktree, "web")
	if err := os.MkdirAll(web, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, web, "init", "-q")
	if err := os.WriteFile(filepath.Join(web, "app.ts"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.updateFacts("ws-multi", func(f *workspaceFacts) {
		f.Checkouts = []Checkout{{Name: "web", BaseBranch: "main"}, {Name: "api", BaseBranch: "main"}}
	})
	got, err := s.Files(context.Background(), "ws-multi")
	if err != nil || !slices.Contains(got.Files, "web/app.ts") {
		t.Fatalf("Files = %q, %v; want web's files despite api", got.Files, err)
	}
	s.updateFacts("ws-multi", func(f *workspaceFacts) {
		f.Checkouts = []Checkout{{Name: "api", BaseBranch: "main"}, {Name: "docs", BaseBranch: "main"}}
	})
	if _, err := s.Files(context.Background(), "ws-multi"); err == nil {
		t.Error("no checkout read, and no error")
	}
}

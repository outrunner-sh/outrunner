package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFilesAndReadFileOfALocalWorktree(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-files", Branch: "runtime/files", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	write := func(name string, data []byte) {
		t.Helper()
		path := filepath.Join(worktree, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("src/app.ts", []byte("export const a = 1;\n"))
	write("logo.png", []byte{0x89, 'P', 'N', 'G', 0, 0})
	write(".gitignore", []byte("secret.env\n"))
	write("secret.env", []byte("KEY=1\n"))
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("not yours\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(worktree, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("src/app.ts", filepath.Join(worktree, "inside.ts")); err != nil {
		t.Fatal(err)
	}

	// Tracked and untracked, not the ignored one, sorted.
	files, truncated, err := s.Files(context.Background(), "ws-files")
	want := []string{".gitignore", "README.md", "escape.txt", "inside.ts", "logo.png", "src/app.ts"}
	if err != nil || truncated || !reflect.DeepEqual(files, want) {
		t.Fatalf("Files = %v, %v, %v; want %v", files, truncated, err, want)
	}
	// A deleted tracked file drops out.
	if err := os.Remove(filepath.Join(worktree, "README.md")); err != nil {
		t.Fatal(err)
	}
	if files, _, _ := s.Files(context.Background(), "ws-files"); len(files) != len(want)-1 {
		t.Errorf("after deleting README.md, Files = %v", files)
	}

	file, err := s.ReadFile(context.Background(), "ws-files", "src/app.ts")
	if err != nil || file.Content != "export const a = 1;\n" || file.Binary || file.Truncated {
		t.Errorf("ReadFile(src/app.ts) = %+v, %v", file, err)
	}
	if file, err := s.ReadFile(context.Background(), "ws-files", "inside.ts"); err != nil || file.Content == "" {
		t.Errorf("a link inside the worktree: %+v, %v", file, err)
	}
	if file, err := s.ReadFile(context.Background(), "ws-files", "logo.png"); err != nil || !file.Binary || file.Content != "" {
		t.Errorf("binary: %+v, %v", file, err)
	}
	// Ignored files aren't listed, but can still be opened.
	if file, err := s.ReadFile(context.Background(), "ws-files", "secret.env"); err != nil || file.Content != "KEY=1\n" {
		t.Errorf("ignored file: %+v, %v", file, err)
	}
	for path, wantErr := range map[string]error{
		"../outside.txt": ErrInvalidPath,
		"/etc/passwd":    ErrInvalidPath,
		"escape.txt":     ErrNoFile,
		"src":            ErrNoFile,
		"README.md":      ErrNoFile,
	} {
		if _, err := s.ReadFile(context.Background(), "ws-files", path); !errors.Is(err, wantErr) {
			t.Errorf("ReadFile(%q): err = %v, want %v", path, err, wantErr)
		}
	}
}

func TestFilesOfAFolderThatIsNotARepository(t *testing.T) {
	folder := t.TempDir()
	for _, name := range []string{"b.txt", "a/c.txt", ".git/HEAD", "node_modules/x/index.js"} {
		path := filepath.Join(folder, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := walkFiles(folder), []string{"a/c.txt", "b.txt"}; !reflect.DeepEqual(got, want) {
		t.Errorf("walkFiles = %v, want %v", got, want)
	}
}

func TestFileContent(t *testing.T) {
	big := strings.Repeat("✓", maxFileBytes/3+1) // the cap lands inside a ✓
	got := fileContent([]byte(big), int64(len(big)))
	if !got.Truncated || got.Binary || !utf8.ValidString(got.Content) || len(got.Content) > maxFileBytes {
		t.Errorf("big file: truncated=%v binary=%v len=%d", got.Truncated, got.Binary, len(got.Content))
	}
	// A sniff that stops mid-character is still text.
	text := strings.Repeat("a", 7999) + "✓"
	if got := fileContent([]byte(text), int64(len(text))); got.Binary {
		t.Error("text whose first 8000 bytes end mid-character read as binary")
	}
	if got := fileContent([]byte{0xff, 0xfe, 'a'}, 3); !got.Binary {
		t.Error("invalid UTF-8 read as text")
	}
}

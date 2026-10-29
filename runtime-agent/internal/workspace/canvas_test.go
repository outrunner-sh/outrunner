package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func canvasService(t *testing.T) (*Service, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.setFacts("ws-1", workspaceFacts{})
	s.makeCanvasDir("ws-1")
	return s, s.canvasDir("ws-1")
}

// The Canvas lists its regular files, newest first, by their paths in it;
// hidden ones and links are left out.
func TestCanvasListsItsFiles(t *testing.T) {
	s, dir := canvasService(t)
	writeTestFile(t, filepath.Join(dir, "plan.md"), "# Plan")
	writeTestFile(t, filepath.Join(dir, "charts", "latency.html"), "<p>hi</p>")
	writeTestFile(t, filepath.Join(dir, ".draft.md"), "hidden")
	writeTestFile(t, filepath.Join(dir, ".cache", "x.md"), "hidden")
	outside := filepath.Join(t.TempDir(), "secret.txt")
	writeTestFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "plan.md"), old, old); err != nil {
		t.Fatal(err)
	}

	canvas, err := s.CanvasFiles("ws-1")
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range canvas.Files {
		paths = append(paths, f.Path)
	}
	if strings.Join(paths, ",") != "charts/latency.html,plan.md" || canvas.Dir != dir {
		t.Fatalf("listing = %q in %s", paths, canvas.Dir)
	}
	if canvas.Files[1].Size != int64(len("# Plan")) {
		t.Errorf("size = %d", canvas.Files[1].Size)
	}
	if _, err := s.CanvasFiles("ws-unknown"); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("another session's Canvas: %v", err)
	}
}

// A session with no Canvas yet lists none, rather than failing.
func TestCanvasNotMadeYetIsEmpty(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.setFacts("ws-1", workspaceFacts{})
	canvas, err := s.CanvasFiles("ws-1")
	if err != nil || len(canvas.Files) != 0 {
		t.Fatalf("listing = %+v, %v", canvas, err)
	}
}

// A file is read only from inside the Canvas: never through a link or `..`,
// and never past the bound.
func TestCanvasFileStaysInTheCanvas(t *testing.T) {
	s, dir := canvasService(t)
	writeTestFile(t, filepath.Join(dir, "charts", "latency.html"), "<p>hi</p>")
	if data, err := s.CanvasFile("ws-1", "charts/latency.html"); err != nil || string(data) != "<p>hi</p>" {
		t.Fatalf("read = %q, %v", data, err)
	}
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "secret.txt"), "secret")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "out")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../../.bashrc", "/etc/passwd", "", "link.txt", "out/secret.txt", "charts"} {
		if _, err := s.CanvasFile("ws-1", path); !errors.Is(err, ErrInvalidCanvasPath) {
			t.Errorf("CanvasFile(%q) = %v, want refused", path, err)
		}
	}
	if _, err := s.CanvasFile("ws-1", "missing.md"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	big := filepath.Join(dir, "big.png")
	if err := os.WriteFile(big, make([]byte, MaxCanvasFileBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CanvasFile("ws-1", "big.png"); !errors.Is(err, ErrCanvasFileTooLarge) {
		t.Errorf("big: %v", err)
	}
}

// The orientation names the folder, and a destroyed session's goes.
func TestCanvasIsNamedAndRemoved(t *testing.T) {
	s, dir := canvasService(t)
	if note := s.canvasNote("ws-1"); !strings.Contains(note, dir) {
		t.Errorf("note doesn't name %s: %q", dir, note)
	}
	s.removeCanvas("ws-1")
	if fileExists(dir) {
		t.Error("the Canvas outlived its session")
	}
}

// Past the bound, the newest files are the ones listed, whatever their names.
func TestCanvasListsTheNewestPastTheBound(t *testing.T) {
	s, dir := canvasService(t)
	old := time.Now().Add(-time.Hour)
	for i := 0; i < MaxCanvasFiles; i++ {
		path := filepath.Join(dir, "old", fmt.Sprintf("a-%04d.md", i))
		writeTestFile(t, path, "x")
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	writeTestFile(t, filepath.Join(dir, "zz-report.md"), "new")
	canvas, err := s.CanvasFiles("ws-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(canvas.Files) != MaxCanvasFiles || !canvas.Truncated || canvas.Files[0].Path != "zz-report.md" {
		t.Fatalf("%d files, truncated %v, first %q", len(canvas.Files), canvas.Truncated, canvas.Files[0].Path)
	}
}

package workspace

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

// A session's Canvas: a folder on the box, outside its worktree, where its
// agent puts what the user should read or look at rather than commit (plans,
// reports, HTML pages, Mermaid diagrams, CSV tables, images). The web app
// lists the folder and shows each file rendered, beside the conversation
// (GET /workspaces/{id}/canvas and /canvas/file). It is the session's own,
// ~/.outrunner/canvas/<id>, since sessions share a computer, and goes when
// the session does; a Snapshot doesn't carry it, as it carries only what git
// tracks.

// MaxCanvasFiles caps a listing; MaxCanvasFileBytes is the largest file the
// app is given to show (a bigger one stays on the box, listed).
const (
	MaxCanvasFiles     = 1000
	MaxCanvasFileBytes = 5 << 20
)

var (
	// ErrInvalidCanvasPath is a path that names no file in the Canvas.
	ErrInvalidCanvasPath = errors.New("not a file in the Canvas")
	// ErrCanvasFileTooLarge is a file past MaxCanvasFileBytes.
	ErrCanvasFileTooLarge = errors.New("too large to show")
)

// canvasDir is a session's Canvas: under the home its agent runs in, where
// it is easy to name ("~/.outrunner/canvas/<id>"), else under Root.
func (s *Service) canvasDir(workspaceID string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = s.Root
	}
	return filepath.Join(home, ".outrunner", "canvas", workspaceID)
}

// makeCanvasDir makes the folder the orientation names, before a launch.
// Best effort: the agent makes it itself if it must.
func (s *Service) makeCanvasDir(workspaceID string) {
	_ = os.MkdirAll(s.canvasDir(workspaceID), 0o755)
}

// removeCanvas removes a destroyed session's Canvas.
func (s *Service) removeCanvas(workspaceID string) {
	_ = os.RemoveAll(s.canvasDir(workspaceID))
}

// CanvasFiles lists a session's Canvas: its regular files, by their paths in
// it, newest first. Hidden files and folders, and links, are left out: a
// link could point anywhere on the box.
func (s *Service) CanvasFiles(workspaceID string) (protocol.CanvasResponse, error) {
	if _, ok := s.getFacts(workspaceID); !ok {
		return protocol.CanvasResponse{}, ErrUnknownWorkspace
	}
	dir := s.canvasDir(workspaceID)
	files := []protocol.CanvasFile{}
	truncated := false
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == dir && errors.Is(err, fs.ErrNotExist) {
				return filepath.SkipAll
			}
			return nil // an unreadable folder is left out
		}
		if path == dir {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if len(files) >= MaxCanvasFiles {
			truncated = true
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		files = append(files, protocol.CanvasFile{
			Path:       filepath.ToSlash(rel),
			Size:       info.Size(),
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
		})
		return nil
	})
	if err != nil {
		return protocol.CanvasResponse{}, err
	}
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].ModifiedAt != files[j].ModifiedAt {
			return files[i].ModifiedAt > files[j].ModifiedAt
		}
		return files[i].Path < files[j].Path
	})
	return protocol.CanvasResponse{Dir: dir, Files: files, Truncated: truncated}, nil
}

// CanvasFile reads one file of a session's Canvas, by its path in it:
// ErrInvalidCanvasPath for one that isn't a regular file inside it (through
// a link, or `..`), ErrCanvasFileTooLarge past the bound, and fs.ErrNotExist
// for none.
func (s *Service) CanvasFile(workspaceID, path string) ([]byte, error) {
	if _, ok := s.getFacts(workspaceID); !ok {
		return nil, ErrUnknownWorkspace
	}
	native := filepath.FromSlash(path)
	if path == "" || !filepath.IsLocal(native) || strings.ContainsRune(path, 0) {
		return nil, ErrInvalidCanvasPath
	}
	dir := s.canvasDir(workspaceID)
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", fs.ErrNotExist, err)
	}
	full := filepath.Join(dir, native)
	// Every step of the path is the Canvas's own: no link out of it, and no
	// link at all, as the listing shows none.
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return nil, err
	}
	if resolved != filepath.Join(root, native) {
		return nil, ErrInvalidCanvasPath
	}
	file, err := os.Open(resolved)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrInvalidCanvasPath
	}
	if info.Size() > MaxCanvasFileBytes {
		return nil, ErrCanvasFileTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxCanvasFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxCanvasFileBytes {
		return nil, ErrCanvasFileTooLarge
	}
	return data, nil
}

// canvasNote tells the agent about the session's Canvas, in its orientation.
func (s *Service) canvasNote(workspaceID string) string {
	dir := s.canvasDir(workspaceID)
	return "# Canvas\n\n" +
		"The user has a Canvas beside this conversation: every file you write in " + dir + " shows there, rendered. " +
		"Put what the user should read or look at, rather than commit, there: plans, reports, write-ups and summaries as Markdown (.md); " +
		"self-contained pages, dashboards and comparison tables as HTML (.html, inline styles and scripts, images as data: URIs; it runs sandboxed, with no access to the app or to other files); " +
		"diagrams as Mermaid (.mmd); tables of data as CSV (.csv); and images (.png, .jpg, .gif, .webp, .svg). " +
		"Use short, descriptive file names (rollout-plan.md, benchmark-results.html), and tell the user what you put there. " +
		"A file over 5 MB is listed but not shown. Keep source code and project files in the repository, not the Canvas."
}

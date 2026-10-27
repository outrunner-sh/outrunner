package workspace

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"runtime-agent/internal/protocol"
)

// The Files panel: every file in the worktree, and one file's text. For a
// Runtime Computer the control plane reads them over Daytona's exec API
// (lib/runtime/git); a local session has no such API, so the agent serves the
// same shapes itself. Kept in step with listWorktreeFiles / readWorktreeFile
// there.

const (
	maxListedFiles = 25_000
	maxFileBytes   = 512_000
)

// ErrNoFile is a path that is not a regular file inside the worktree: gone,
// a directory, or a link that leads out of it.
var ErrNoFile = errors.New("file not found in this workspace")

// Files lists the worktree's files, tracked and untracked, without the ignored
// ones, sorted; truncated says the list was cut at maxListedFiles.
func (s *Service) Files(ctx context.Context, workspaceID string) ([]string, bool, error) {
	worktree := s.worktreePath(workspaceID)
	var files []string
	if f, ok := s.getFacts(workspaceID); ok && f.InPlace {
		files = walkFiles(worktree)
	} else {
		listed, err := s.gitRaw(ctx, worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
		if err != nil {
			return nil, false, err
		}
		// Deleted but still in the index: nothing to open.
		deleted, err := s.gitRaw(ctx, worktree, "ls-files", "--deleted", "-z")
		if err != nil {
			return nil, false, err
		}
		files = worktreeFiles(listed, deleted)
	}
	truncated := len(files) > maxListedFiles
	if truncated {
		files = files[:maxListedFiles]
	}
	return files, truncated, nil
}

// worktreeFiles is `git ls-files -z` less the deleted ones, sorted, each once.
func worktreeFiles(listed, deleted string) []string {
	gone := map[string]bool{}
	for _, path := range strings.Split(deleted, "\x00") {
		gone[path] = true
	}
	seen := map[string]bool{}
	files := []string{}
	for _, path := range strings.Split(listed, "\x00") {
		if path != "" && !gone[path] && !seen[path] {
			seen[path] = true
			files = append(files, path)
		}
	}
	sort.Strings(files)
	return files
}

// walkFiles lists a folder that is not a repository, skipping what no one
// browses (.git, node_modules) and stopping one past the cap.
func walkFiles(root string) []string {
	files := []string{}
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && (d.Name() == ".git" || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if rel, err := filepath.Rel(root, path); err == nil {
			files = append(files, filepath.ToSlash(rel))
		}
		if len(files) > maxListedFiles {
			return filepath.SkipAll
		}
		return nil
	})
	sort.Strings(files)
	return files
}

// ReadFile is one worktree file's text, up to maxFileBytes. A link is followed
// only while it stays inside the worktree; a binary file comes back marked as
// such, without its bytes.
func (s *Service) ReadFile(_ context.Context, workspaceID, path string) (protocol.FileContent, error) {
	if !safeRelativePath(path) {
		return protocol.FileContent{}, ErrInvalidPath
	}
	root, err := filepath.EvalSymlinks(s.worktreePath(workspaceID))
	if err != nil {
		return protocol.FileContent{}, err
	}
	file, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(path)))
	if err != nil || !strings.HasPrefix(file, root+string(filepath.Separator)) {
		return protocol.FileContent{}, ErrNoFile
	}
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return protocol.FileContent{}, ErrNoFile
	}
	f, err := os.Open(file)
	if err != nil {
		return protocol.FileContent{}, ErrNoFile
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return protocol.FileContent{}, err
	}
	return fileContent(data, info.Size()), nil
}

// fileContent is the panel's view of a file's first bytes: binary when they
// hold a NUL or aren't UTF-8, else the text, cut at maxFileBytes on a
// character boundary.
func fileContent(data []byte, size int64) protocol.FileContent {
	sniff := data
	if len(sniff) > 8000 {
		sniff = sniff[:8000]
	}
	// The sniff may end mid-character; only what precedes it must be valid.
	if bytes.IndexByte(sniff, 0) >= 0 || !utf8.Valid(trimPartialRune(sniff)) {
		return protocol.FileContent{Binary: true, Size: size}
	}
	truncated := len(data) > maxFileBytes
	if truncated {
		data = trimPartialRune(data[:maxFileBytes])
	}
	return protocol.FileContent{Content: string(data), Truncated: truncated, Size: size}
}

// trimPartialRune drops a character cut short at the end of b.
func trimPartialRune(b []byte) []byte {
	for i := 1; i <= utf8.UTFMax && i <= len(b); i++ {
		if utf8.RuneStart(b[len(b)-i]) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i]
			}
			break
		}
	}
	return b
}

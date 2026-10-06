package workspace

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"runtime-agent/internal/protocol"
)

// The change set the Changes panel shows. For a Runtime Computer the control
// plane computes it over Daytona's exec API (lib/runtime/git); a local session
// has no such API, so the agent serves the same projection itself. Kept in step
// with listChangedFiles / readFileDiff there.

const (
	maxChangedFiles = 500
	maxDiffBytes    = 200_000
)

var (
	// ErrInvalidPath is a requested path that could escape the worktree or be
	// read by git as pathspec magic.
	ErrInvalidPath = errors.New("invalid changed file path")
	// ErrNotChanged is a path outside the current change set.
	ErrNotChanged = errors.New("file is not part of this workspace change set")
)

// Changes lists the worktree's changed files, untracked included.
func (s *Service) Changes(ctx context.Context, workspaceID string) ([]protocol.ChangedFile, error) {
	// A folder that is not a repository has no change set to show.
	if f, ok := s.getFacts(workspaceID); ok && f.InPlace {
		return []protocol.ChangedFile{}, nil
	}
	out, err := s.gitRaw(ctx, s.worktreePath(workspaceID),
		"status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	return parseChangedFiles(out), nil
}

// FileDiff is a bounded, text-only diff of one file in the change set.
func (s *Service) FileDiff(ctx context.Context, workspaceID, path string) (string, error) {
	if !safeRelativePath(path) {
		return "", ErrInvalidPath
	}
	files, err := s.Changes(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	var file *protocol.ChangedFile
	for i := range files {
		if files[i].Path == path {
			file = &files[i]
			break
		}
	}
	if file == nil {
		return "", ErrNotChanged
	}
	if file.Status == "untracked" {
		return "This untracked file has no Git diff yet.", nil
	}
	diff, err := s.gitRaw(ctx, s.worktreePath(workspaceID),
		"--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--", path)
	if err != nil {
		return "", err
	}
	return limitText(diff, maxDiffBytes), nil
}

// parseChangedFiles reads `git status --porcelain=v1 -z`.
func parseChangedFiles(output string) []protocol.ChangedFile {
	entries := strings.Split(output, "\x00")
	files := make([]protocol.ChangedFile, 0, len(entries))
	for i := 0; i < len(entries) && len(files) < maxChangedFiles; i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		code, path := entry[:2], entry[3:]
		// A rename or copy carries its original name as the next field.
		renamed := strings.ContainsAny(code, "RC")
		if renamed {
			i++
		}
		status := "modified"
		switch {
		case code == "??":
			status = "untracked"
		case strings.Contains(code, "A"):
			status = "added"
		case strings.Contains(code, "D"):
			status = "deleted"
		case renamed:
			status = "renamed"
		}
		files = append(files, protocol.ChangedFile{Path: path, Status: status})
	}
	return files
}

// safeRelativePath rejects traversal, absolute paths and pathspec magic before
// a caller-supplied path becomes a git argument.
func safeRelativePath(path string) bool {
	if path == "" || strings.ContainsRune(path, 0) || strings.HasPrefix(path, "/") || strings.HasPrefix(path, ":") {
		return false
	}
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == "." || part == ".." {
			return false
		}
	}
	return !strings.Contains(path, "//")
}

// limitText caps a diff without splitting a UTF-8 character.
func limitText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	cut := value[:maxBytes]
	for !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + "\n\n… diff truncated by Runtime …"
}

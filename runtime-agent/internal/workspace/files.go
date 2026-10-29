package workspace

import (
	"context"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"runtime-agent/internal/protocol"
)

// The files the composer's @ mentions offer: a session's whole tree, its
// changed files first, so what the agent just touched is a keystroke or two
// away. Read by git (tracked, and untracked but not ignored), as the Changes
// panel is; a folder that isn't a repository is walked instead.

// MaxListedFiles caps a listing: a monorepo's hundreds of thousands of paths
// would cost the page more to fuzzy-search than any mention is worth.
const MaxListedFiles = 20_000

// skippedDirs are left out of a walk of a folder that isn't a repository:
// there is no .gitignore to say so, and they are where a tree is largest.
var skippedDirs = map[string]bool{".git": true, "node_modules": true, ".next": true, "dist": true, "build": true, "target": true, ".venv": true, "__pycache__": true}

// Files lists a session's files for the composer to mention.
func (s *Service) Files(ctx context.Context, workspaceID string) (protocol.FilesResponse, error) {
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return protocol.FilesResponse{}, ErrUnknownWorkspace
	}
	worktree := s.worktreePath(workspaceID)
	var all []string
	if f.InPlace {
		all = walkFiles(worktree)
	} else {
		dirs := []struct{ dir, prefix string }{{worktree, ""}}
		if len(f.Checkouts) > 0 {
			dirs = dirs[:0]
			for _, c := range f.Checkouts {
				dirs = append(dirs, struct{ dir, prefix string }{filepath.Join(worktree, c.Name), c.Name + "/"})
			}
		}
		// A checkout git can't read (mid-clone, a broken index) is left out,
		// as the change set is below: the others are still a listing. Only
		// none read at all is an error.
		var unread error
		read := 0
		for _, d := range dirs {
			out, err := s.gitRaw(ctx, d.dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
			if err != nil {
				log.Printf("workspace %s: files of %s left out of the listing: %v", workspaceID, d.dir, err)
				unread = err
				continue
			}
			read++
			for _, path := range strings.Split(out, "\x00") {
				if path != "" {
					all = append(all, d.prefix+path)
				}
			}
		}
		if read == 0 && unread != nil {
			return protocol.FilesResponse{}, unread
		}
	}
	// The change set's files that are still there, newest first. A listing
	// whose changes can't be read is still a listing.
	var changed []string
	if sets, err := s.changeSets(ctx, workspaceID); err == nil {
		modified := map[string]int64{}
		for _, set := range sets {
			for _, file := range set.files {
				info, err := os.Stat(filepath.Join(worktree, file.Path))
				if file.Status == "deleted" || err != nil || info.IsDir() {
					continue
				}
				changed = append(changed, file.Path)
				modified[file.Path] = info.ModTime().UnixNano()
			}
		}
		sort.SliceStable(changed, func(i, j int) bool { return modified[changed[i]] > modified[changed[j]] })
	}
	return listing(changed, all), nil
}

// listing puts the changed files first, then the rest in order, each once,
// capped at MaxListedFiles.
func listing(changed, all []string) protocol.FilesResponse {
	out := protocol.FilesResponse{Files: []string{}}
	seen := map[string]bool{}
	add := func(path string) bool {
		if seen[path] {
			return true
		}
		if len(out.Files) == MaxListedFiles {
			out.Truncated = true
			return false
		}
		seen[path] = true
		out.Files = append(out.Files, path)
		return true
	}
	for _, path := range changed {
		if !add(path) {
			break
		}
	}
	out.Changed = len(out.Files)
	sort.Strings(all)
	for _, path := range all {
		if !add(path) {
			break
		}
	}
	return out
}

// walkFiles lists a folder's files, by path in it, past the directories a
// tree is largest in, and stops a little over the cap (listing says so).
func walkFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner is left out, not the listing
		}
		if d.IsDir() {
			if path != root && (skippedDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if rel, err := filepath.Rel(root, path); err == nil {
			files = append(files, filepath.ToSlash(rel))
		}
		if len(files) > MaxListedFiles {
			return filepath.SkipAll
		}
		return nil
	})
	return files
}

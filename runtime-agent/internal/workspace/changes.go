package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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
	// maxDiffedFileBytes is the largest file whose diff is worked out: git
	// holds both sides of a diff in memory, several times their size, so a
	// big generated file or dump could take a small box's agent down with it.
	// Only maxDiffBytes of a diff would show anyway.
	maxDiffedFileBytes = 20 << 20
	// maxCountedFileBytes is the largest untracked file whose lines are
	// counted: git reads a file whole to count them, or to find it binary,
	// and the panel asks every few seconds.
	maxCountedFileBytes = 1 << 20
)

var (
	// ErrInvalidPath is a requested path that could escape the worktree or be
	// read by git as pathspec magic.
	ErrInvalidPath = errors.New("invalid changed file path")
	// ErrNotChanged is a path outside the current change set.
	ErrNotChanged = errors.New("file is not part of this workspace change set")
)

// Changes lists the worktree's changed files since it left its base branch,
// committed or not, untracked included. A folder of checkouts lists each
// one's, its paths under its folder ("api/src/x.ts").
func (s *Service) Changes(ctx context.Context, workspaceID string) ([]protocol.ChangedFile, error) {
	sets, err := s.changeSets(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	files := []protocol.ChangedFile{}
	for _, set := range sets {
		files = append(files, set.files...)
	}
	return files, nil
}

// changeSetIn is one checkout's change set: its files (paths as listed),
// where it is, the prefix its paths carry and the commit it is measured from.
type changeSetIn struct {
	files  []protocol.ChangedFile
	dir    string
	prefix string
	base   string
}

// changeSets are the session's change sets, one a checkout.
func (s *Service) changeSets(ctx context.Context, workspaceID string) ([]changeSetIn, error) {
	f, ok := s.getFacts(workspaceID)
	// A folder that is not a repository has no change set to show.
	if ok && f.InPlace {
		return nil, nil
	}
	worktree := s.worktreePath(workspaceID)
	if len(f.Checkouts) == 0 {
		files, base, err := s.changeSet(ctx, worktree, f.BaseBranch)
		if err != nil {
			return nil, err
		}
		return []changeSetIn{{files: files, dir: worktree, base: base}}, nil
	}
	var sets []changeSetIn
	for _, c := range f.Checkouts {
		dir := filepath.Join(worktree, c.Name)
		files, base, err := s.changeSet(ctx, dir, c.BaseBranch)
		if err != nil {
			return nil, err
		}
		prefix := c.Name + "/"
		for i := range files {
			files[i].Path = prefix + files[i].Path
		}
		sets = append(sets, changeSetIn{files: files, dir: dir, prefix: prefix, base: base})
	}
	return sets, nil
}

// changeSet is one checkout's changes and the commit they are measured from.
func (s *Service) changeSet(ctx context.Context, worktree, baseBranch string) ([]protocol.ChangedFile, string, error) {
	base := s.changeBase(ctx, worktree, baseBranch)
	// Against a commit, `git diff` covers staged and unstaged changes alike.
	diff := func(format string) (string, error) {
		return s.gitRaw(ctx, worktree, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", format, "-z", base, "--")
	}
	nameStatus, err := diff("--name-status")
	if err != nil {
		return nil, "", err
	}
	numstat, err := diff("--numstat")
	if err != nil {
		return nil, "", err
	}
	untracked, err := s.gitRaw(ctx, worktree, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, "", err
	}
	files := parseChangedFiles(nameStatus, numstat, untracked)
	s.countUntrackedLines(ctx, worktree, files)
	return files, base, nil
}

// countUntrackedLines sets each untracked file's additions to its line count,
// as a diff against nothing would. One `git grep` counts them all: the empty
// pattern matches every line and -I skips binaries, which stay at 0. The
// counts are a nicety, so a grep that fails or matches nothing leaves them at
// 0, as does a file over maxCountedFileBytes (model weights, a database, a
// log), which git would read whole on every look at the panel.
func (s *Service) countUntrackedLines(ctx context.Context, worktree string, files []protocol.ChangedFile) {
	args := []string{"--literal-pathspecs", "grep", "--untracked", "--no-color", "-I", "-c", "-z", "-e", "", "--"}
	var untracked []int
	for i, f := range files {
		if f.Status != "untracked" {
			continue
		}
		if info, err := os.Stat(filepath.Join(worktree, f.Path)); err != nil || info.Size() > maxCountedFileBytes {
			continue
		}
		untracked = append(untracked, i)
		args = append(args, f.Path)
	}
	if len(untracked) == 0 {
		return
	}
	out, err := s.gitRaw(ctx, worktree, args...)
	if err != nil {
		return
	}
	counts := parseLineCounts(out)
	for _, i := range untracked {
		files[i].Additions = counts[files[i].Path]
	}
}

// parseLineCounts reads `git grep -c -z`, which prints "path\0count\n" per
// file. A path may hold a newline but a count cannot, so the first newline
// after each count starts the next path.
func parseLineCounts(output string) map[string]int {
	counts := map[string]int{}
	fields := strings.Split(output, "\x00")
	path := fields[0]
	for _, field := range fields[1:] {
		count, next, _ := strings.Cut(field, "\n")
		if n, err := strconv.Atoi(count); err == nil && path != "" && n >= 0 {
			counts[path] = n
		}
		path = next
	}
	return counts
}

// changeBase is where a change set is measured from: the commit the branch
// left its base at (its merge-base with origin/<base>, else with a local
// <base>, as resolveBase forks from), so work already committed or pushed
// still shows. When no base resolves it is HEAD, which leaves just the
// uncommitted changes.
func (s *Service) changeBase(ctx context.Context, worktree, baseBranch string) string {
	if baseBranch == "" || strings.HasPrefix(baseBranch, "-") {
		return "HEAD"
	}
	for _, ref := range []string{"origin/" + baseBranch, baseBranch} {
		if sha, err := s.git(ctx, worktree, "merge-base", ref, "HEAD"); err == nil && sha != "" {
			return sha
		}
	}
	return "HEAD"
}

// FileDiff is a bounded, text-only diff of one file in the change set,
// measured from the same base.
func (s *Service) FileDiff(ctx context.Context, workspaceID, path string) (string, error) {
	if !safeRelativePath(path) {
		return "", ErrInvalidPath
	}
	sets, err := s.changeSets(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	var file *protocol.ChangedFile
	var in changeSetIn
	for _, set := range sets {
		for i := range set.files {
			if set.files[i].Path == path {
				file, in = &set.files[i], set
				break
			}
		}
	}
	if file == nil {
		return "", ErrNotChanged
	}
	if file.Status == "untracked" {
		return "This untracked file has no Git diff yet.", nil
	}
	// Against the change set's base commit rather than the index, so a change
	// Claude has staged (`git add`) shows too, as does one already committed. A
	// file is listed only when it differs from that base, so its patch has
	// something in it: a staged edit whose working copy was changed back is no
	// longer listed at all.
	rel := strings.TrimPrefix(path, in.prefix)
	if size := s.diffedSize(ctx, in.dir, in.base, rel); size > maxDiffedFileBytes {
		return fmt.Sprintf("This file is too large to show its diff here (%d MB).", size>>20), nil
	}
	diff, err := s.gitCapped(ctx, in.dir, maxDiffBytes,
		"--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", in.base, "--", rel)
	if err != nil {
		return "", err
	}
	return limitText(diff, maxDiffBytes), nil
}

// diffedSize is the larger side of a file's diff, in bytes: the file as it is
// in the worktree, or as it was at the base commit (a deleted file's only
// side). A side that isn't there counts 0.
func (s *Service) diffedSize(ctx context.Context, dir, base, rel string) int64 {
	var size int64
	if info, err := os.Lstat(filepath.Join(dir, rel)); err == nil {
		size = info.Size()
	}
	if out, err := s.git(ctx, dir, "cat-file", "-s", base+":"+rel); err == nil {
		if n, err := strconv.ParseInt(out, 10, 64); err == nil && n > size {
			size = n
		}
	}
	return size
}

// parseChangedFiles joins `git diff --name-status -z`, `git diff --numstat -z`
// and `git ls-files --others -z` into one change set.
func parseChangedFiles(nameStatus, numstat, untracked string) []protocol.ChangedFile {
	counts := parseNumstat(numstat)
	fields := strings.Split(nameStatus, "\x00")
	files := make([]protocol.ChangedFile, 0, len(fields)/2)
	listed := map[string]bool{}
	for i := 0; i < len(fields); i++ {
		code := fields[i]
		if code == "" {
			continue
		}
		// A rename or copy ("R100", "C75") is followed by its old and new names.
		if code[0] == 'R' || code[0] == 'C' {
			i++
		}
		i++
		if i >= len(fields) || fields[i] == "" {
			continue
		}
		path := fields[i]
		status := "modified"
		switch code[0] {
		case 'A', 'C': // a copy leaves its original in place
			status = "added"
		case 'D':
			status = "deleted"
		case 'R':
			status = "renamed"
		}
		c := counts[path]
		files = append(files, protocol.ChangedFile{Path: path, Status: status, Additions: c[0], Deletions: c[1]})
		listed[path] = true
	}
	// A file dropped from the index but left on disk is both a deletion and
	// untracked; list it once.
	for _, path := range strings.Split(untracked, "\x00") {
		if path != "" && !listed[path] {
			files = append(files, protocol.ChangedFile{Path: path, Status: "untracked"})
		}
	}
	if len(files) > maxChangedFiles {
		files = files[:maxChangedFiles]
	}
	return files
}

// parseNumstat reads `git diff --numstat -z` into [additions, deletions] by
// path. A binary file counts "-", read as 0; a rename leaves the path empty
// and puts its old and new names in the next two fields.
func parseNumstat(output string) map[string][2]int {
	counts := map[string][2]int{}
	fields := strings.Split(output, "\x00")
	for i := 0; i < len(fields); i++ {
		// A path may itself hold tabs, so only the first two separate counts.
		parts := strings.SplitN(fields[i], "\t", 3)
		if len(parts) != 3 {
			continue
		}
		added, okAdded := numstatCount(parts[0])
		deleted, okDeleted := numstatCount(parts[1])
		if !okAdded || !okDeleted {
			continue
		}
		path := parts[2]
		if path == "" {
			i += 2
			if i >= len(fields) {
				break
			}
			path = fields[i]
		}
		counts[path] = [2]int{added, deleted}
	}
	return counts
}

// numstatCount reads one numstat column: a line count, or "-" for binary.
func numstatCount(value string) (int, bool) {
	if value == "-" {
		return 0, true
	}
	n, err := strconv.Atoi(value)
	return n, err == nil && n >= 0
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

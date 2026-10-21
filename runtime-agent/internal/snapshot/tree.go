package snapshot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// buildBundle writes a git bundle of the worktree's full history (all refs) to
// dst. The bundle is the "committed" half of the tree; Restore clones from it.
func buildBundle(ctx context.Context, worktree, dst string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"bundle", "create", dst, "--all").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git bundle: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return dst, nil
}

// buildPatch writes the worktree's WorkingPatch to dst.
func buildPatch(ctx context.Context, worktree, dst string) (string, error) {
	if err := os.WriteFile(dst, WorkingPatch(ctx, worktree), 0o644); err != nil {
		return "", fmt.Errorf("write patch: %w", err)
	}
	return dst, nil
}

// WorkingPatch is a patch of the working-tree changes relative to HEAD, so
// Restore can reconstruct exact WIP — including binary changes and untracked
// files. `--binary` serializes binary blobs so `git apply` can rebuild them.
// Untracked (non-ignored) files are added intent-to-add so they appear as
// new-file diffs — in a copy of the index, never the worktree's own: someone
// may be working in it (a local checkout imported while its agent runs), and
// their index, staged changes included, is left exactly as it was. An empty
// patch (no WIP, or a broken repo) is valid.
//
// `.gitignore`d files are excluded by design.
func WorkingPatch(ctx context.Context, worktree string) []byte {
	env := os.Environ()
	if others := untrackedFiles(ctx, worktree); len(others) > 0 {
		index, cleanup, err := indexCopy(ctx, worktree)
		if err == nil {
			defer cleanup()
			env = append(env, "GIT_INDEX_FILE="+index)
			add := exec.CommandContext(ctx, "git", append([]string{"-C", worktree, "add", "-N", "--"}, others...)...)
			add.Env = env
			_ = add.Run() // best-effort: without it, only tracked changes are captured
		}
	}
	diff := exec.CommandContext(ctx, "git", "-C", worktree, "diff", "HEAD", "--binary")
	diff.Env = env
	out, err := diff.Output()
	if err != nil {
		// A broken repo is the only real failure here; degrade to an empty patch
		// rather than aborting the whole capture over WIP.
		return nil
	}
	return out
}

// indexCopy copies the worktree's index to a temporary file. Git replaces an
// index by renaming a finished one into place, so the copy is never half
// written. A repository with no index yet gets a path to none, which git reads
// as empty.
func indexCopy(ctx context.Context, worktree string) (string, func(), error) {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "rev-parse", "--git-path", "index").Output()
	if err != nil {
		return "", nil, err
	}
	index := strings.TrimSpace(string(out))
	if !filepath.IsAbs(index) {
		index = filepath.Join(worktree, index)
	}
	dir, err := os.MkdirTemp("", "patch-index-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	copied := filepath.Join(dir, "index")
	data, err := os.ReadFile(index)
	if err == nil {
		err = os.WriteFile(copied, data, 0o600)
	} else if os.IsNotExist(err) {
		err = nil
	}
	if err != nil {
		cleanup()
		return "", nil, err
	}
	return copied, cleanup, nil
}

// untrackedFiles lists the worktree's untracked, non-ignored files.
func untrackedFiles(ctx context.Context, worktree string) []string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"ls-files", "--others", "--exclude-standard", "-z").Output()
	if err != nil || len(out) == 0 {
		return nil
	}
	var files []string
	for _, name := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		if name != "" {
			files = append(files, name)
		}
	}
	return files
}

// lastCommit returns the worktree's HEAD sha, or nil when there are no commits.
func lastCommit(ctx context.Context, worktree string) *string {
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "rev-parse", "HEAD").Output()
	if err != nil {
		return nil
	}
	sha := strings.TrimSpace(string(out))
	if sha == "" {
		return nil
	}
	return &sha
}

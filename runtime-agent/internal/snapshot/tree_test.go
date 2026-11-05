package snapshot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The patch takes untracked files in without touching the worktree's index:
// a staged change stays staged, and nothing is left intent-to-add.
func TestWorkingPatchLeavesTheIndexAsItWas(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q", "-b", "main")
	write("a.txt", "a\n")
	git("add", "-A")
	git("commit", "-q", "-m", "base")
	write("a.txt", "a staged\n")
	git("add", "a.txt")
	write("new.txt", "untracked\n")

	index := filepath.Join(dir, ".git", "index")
	before, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}

	patch := string(WorkingPatch(context.Background(), dir))

	for _, want := range []string{"a staged", "+untracked"} {
		if !strings.Contains(patch, want) {
			t.Errorf("patch is missing %q:\n%s", want, patch)
		}
	}
	after, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("the worktree's index changed; status now:\n%s", git("status", "--short"))
	}
}

// An un-ignored folder of dependencies holds tens of thousands of untracked
// files: as arguments of one `git add -N` they ran past the system's limit,
// the add failed, and the patch held no untracked file at all, not even the
// one the agent wrote.
func TestWorkingPatchKeepsUntrackedFilesWhenThereAreMany(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-q", "-m", "base")
	if err := os.WriteFile(filepath.Join(dir, "feature.txt"), []byte("the agent wrote this\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deps := filepath.Join(dir, "node_modules", "a-package-with-a-rather-long-name-indeed", "dist", "internal", "modules")
	if err := os.MkdirAll(deps, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25000; i++ {
		if err := os.WriteFile(filepath.Join(deps, fmt.Sprintf("module_%06d.js", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	patch := filepath.Join(t.TempDir(), "patch")
	if _, err := buildPatch(context.Background(), dir, patch); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(patch)
	if !bytes.Contains(data, []byte("+the agent wrote this")) {
		t.Fatalf("the patch (%d bytes) lost the untracked feature.txt", len(data))
	}
}

// A worktree that isn't a repository any more has an empty patch, not a
// failed capture.
func TestBuildPatchOfABrokenRepositoryIsEmpty(t *testing.T) {
	patch := filepath.Join(t.TempDir(), "patch")
	if _, err := buildPatch(context.Background(), t.TempDir(), patch); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(patch); err != nil || len(data) != 0 {
		t.Fatalf("patch = %q, %v; want an empty file", data, err)
	}
}

// A working repository whose diff fails (a full disk as it is written) fails
// the capture: an empty patch would pass for "no changes", and the archive
// would go on without the session's uncommitted work.
func TestBuildPatchFailsWhenAWorkingRepositorysDiffFails(t *testing.T) {
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command(realGit, append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-q", "-m", "base")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("uncommitted work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A git whose diff fails part way, as on a full disk; everything else is git.
	bin := t.TempDir()
	fake := "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = diff ] && { echo 'fatal: write error: No space left on device' >&2; exit 128; }; done\nexec " + realGit + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	_, err = buildPatch(context.Background(), dir, filepath.Join(t.TempDir(), "patch"))
	if err == nil {
		t.Fatal("buildPatch succeeded with an empty patch; want the capture failed")
	}
	// git's own words reach the archive's log.
	if !strings.Contains(err.Error(), "No space left on device") {
		t.Errorf("error %q lost git's stderr", err)
	}
}

// A capture cut off (its deadline passed) fails, rather than taking the
// repository for broken and saving an empty patch as "no changes".
func TestBuildPatchFailsWhenTheCaptureIsCutOff(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("git", "-C", dir, "init", "-q", "-b", "main")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := buildPatch(ctx, dir, filepath.Join(t.TempDir(), "patch")); !errors.Is(err, context.Canceled) {
		t.Fatalf("buildPatch on a cut-off capture = %v; want context.Canceled", err)
	}
}

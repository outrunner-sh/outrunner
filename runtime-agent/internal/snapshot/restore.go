package snapshot

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/transcript"
)

// MaterializeInput is everything the agent needs to rebuild a Session's
// filesystem from a Snapshot's tree, on a possibly-fresh box.
type MaterializeInput struct {
	// MirrorPath is the shared bare mirror the worktree attaches to.
	MirrorPath string
	// WorktreePath is where the restored worktree is created.
	WorktreePath string
	// Branch is the workspace branch to check out (carried in the bundle).
	Branch string
	// BundleRef is the branch as the bundle names it, when not Branch: it is
	// imported under Branch.
	BundleRef string
	// OriginWorktree, when set, is the folder the conversation was recorded
	// in elsewhere (an imported session's): the working directories it
	// records under it are moved to WorktreePath.
	OriginWorktree string
	// ConversationDest, when non-empty, is the absolute path to write the
	// conversation JSONL so `claude --continue` finds the archived session.
	ConversationDest string
	// RolloutDest, when non-empty, is where a Codex session's raw rollout is
	// written, if the Snapshot has one (its download is optional).
	RolloutDest string
	// Downloads maps artifact (bundle/patch/conversation/rollout) -> signed
	// download URL.
	Downloads []protocol.RestoreDownload
	// Checkouts, when set, restore a session of several repositories: the
	// bundle and patch are its tars (checkouts.go), each checkout rebuilt
	// in WorktreePath/<name> off its own mirror.
	Checkouts []Checkout
}

// Materialize rebuilds the worktree from the Snapshot and VERIFIES it before the
// caller boots Claude (M4 invariant #4). It imports the bundle into the mirror,
// checks out the branch as a worktree, applies the uncommitted patch, places the
// conversation JSONL, and asserts each gate. Any failure returns an error and
// the caller must NOT launch Claude.
//
// Idempotent: an existing worktree is removed and rebuilt, so a re-run (or a
// retry after a partial restore) converges rather than failing.
func Materialize(ctx context.Context, in MaterializeInput) error {
	urls := map[string]string{}
	encodings := map[string]string{}
	for _, d := range in.Downloads {
		urls[d.Artifact] = d.URL
		encodings[d.Artifact] = d.Encoding
	}
	get := func(artifact, dst string) error {
		return download(ctx, urls[artifact], encodings[artifact], dst)
	}
	required := []string{"bundle", "patch"}
	// When a conversation destination is set (it always is for a real restore),
	// the conversation URL is mandatory — otherwise Claude would `--continue` with
	// no session JSONL, an incomplete restore. Fail closed rather than silently
	// booting into a session that can't resume.
	if in.ConversationDest != "" {
		required = append(required, "conversation")
	}
	for _, name := range required {
		if urls[name] == "" {
			return fmt.Errorf("restore is missing the %s download URL", name)
		}
	}

	staging, err := os.MkdirTemp("", "restore-")
	if err != nil {
		return fmt.Errorf("restore staging dir: %w", err)
	}
	defer os.RemoveAll(staging)

	bundlePath := filepath.Join(staging, BundleName)
	if err := get("bundle", bundlePath); err != nil {
		return fmt.Errorf("download bundle: %w", err)
	}
	patchPath := filepath.Join(staging, PatchName)
	if err := get("patch", patchPath); err != nil {
		return fmt.Errorf("download patch: %w", err)
	}

	if len(in.Checkouts) > 0 {
		if err := os.MkdirAll(in.WorktreePath, 0o755); err != nil {
			return err
		}
		if err := materializeCheckouts(ctx, in.WorktreePath, in.Branch, in.BundleRef, bundlePath, patchPath, in.Checkouts, staging); err != nil {
			return err
		}
	} else {
		// Tear down any prior worktree BEFORE importing — git refuses to fetch into a
		// branch that's currently checked out, so a re-run must free the branch first.
		removeWorktree(ctx, in.MirrorPath, in.WorktreePath)

		bundleRef := in.BundleRef
		if bundleRef == "" {
			bundleRef = in.Branch
		}
		if err := importBundle(ctx, in.MirrorPath, bundlePath, bundleRef, in.Branch); err != nil {
			return err
		}
		if err := addWorktree(ctx, in.MirrorPath, in.WorktreePath, in.Branch); err != nil {
			return err
		}
		if err := applyPatch(ctx, in.WorktreePath, patchPath); err != nil {
			return err
		}
	}

	if in.ConversationDest != "" {
		if err := get("conversation", in.ConversationDest); err != nil {
			return fmt.Errorf("download conversation: %w", err)
		}
		if info, err := os.Stat(in.ConversationDest); err != nil || info.Size() == 0 {
			return fmt.Errorf("restore: conversation JSONL was not written to %s", in.ConversationDest)
		}
	}
	if in.RolloutDest != "" && urls["rollout"] != "" {
		if err := get("rollout", in.RolloutDest); err != nil {
			return fmt.Errorf("download rollout: %w", err)
		}
	}
	if in.OriginWorktree != "" {
		for _, path := range []string{in.ConversationDest, in.RolloutDest} {
			if _, err := os.Stat(path); path == "" || err != nil {
				continue
			}
			if err := transcript.RewriteCwd(path, in.OriginWorktree, in.WorktreePath); err != nil {
				return fmt.Errorf("move the conversation to the worktree: %w", err)
			}
		}
	}

	if len(in.Checkouts) > 0 {
		return nil // each checkout verified as it was rebuilt
	}
	return verify(ctx, in.MirrorPath, in.WorktreePath, in.Branch)
}

// importBundle pulls the archived branch (and its history) out of the bundle into
// the shared mirror, so a worktree can then check it out. The bundle carries
// commits the freshly-cloned mirror doesn't have (they only ever lived in the
// archived worktree), which is what makes restore box-independent. The
// bundle's branch is from; it is checked out as branch.
func importBundle(ctx context.Context, mirror, bundlePath, from, branch string) error {
	ref := fmt.Sprintf("+refs/heads/%s:refs/heads/%s", from, branch)
	out, err := exec.CommandContext(ctx, "git", "-C", mirror,
		"fetch", bundlePath, ref).CombinedOutput()
	if err != nil {
		return fmt.Errorf("import bundle: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// removeWorktree tears down a prior (possibly partial) worktree so a re-run is
// idempotent and the branch is free to be fetched into. Best-effort.
func removeWorktree(ctx context.Context, mirror, worktree string) {
	if _, err := os.Stat(worktree); err != nil {
		return
	}
	_ = exec.CommandContext(ctx, "git", "-C", mirror,
		"worktree", "remove", "--force", worktree).Run()
	_ = os.RemoveAll(worktree)
	// Drop a stale administrative entry if the dir was already gone.
	_ = exec.CommandContext(ctx, "git", "-C", mirror, "worktree", "prune").Run()
}

// addWorktree checks the restored branch out as a worktree.
func addWorktree(ctx context.Context, mirror, worktree, branch string) error {
	if err := os.MkdirAll(filepath.Dir(worktree), 0o755); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, "git", "-C", mirror,
		"worktree", "add", worktree, branch).CombinedOutput()
	if err != nil {
		return fmt.Errorf("worktree add: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// applyPatch restores the uncommitted WIP on top of the checked-out branch. An
// empty patch is a no-op. A patch that doesn't apply cleanly fails the restore
// (invariant #4: never boot Claude into a broken tree).
func applyPatch(ctx context.Context, worktree, patchPath string) error {
	info, err := os.Stat(patchPath)
	if err != nil || info.Size() == 0 {
		return nil // no WIP captured
	}
	out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"apply", "--whitespace=nowarn", patchPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("apply patch: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// verify asserts the restore gates before Claude is launched: the branch was
// imported into the mirror and the worktree has a valid HEAD.
func verify(ctx context.Context, mirror, worktree, branch string) error {
	if out, err := exec.CommandContext(ctx, "git", "-C", mirror,
		"rev-parse", "--verify", "refs/heads/"+branch).CombinedOutput(); err != nil {
		return fmt.Errorf("verify: branch %q missing after bundle import: %v: %s",
			branch, err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.CommandContext(ctx, "git", "-C", worktree,
		"rev-parse", "--verify", "HEAD").CombinedOutput(); err != nil {
		return fmt.Errorf("verify: worktree has no valid HEAD: %v: %s",
			err, strings.TrimSpace(string(out)))
	}
	return nil
}

// DownloadArtifact writes a Snapshot artifact's signed download URL to dst,
// for a restore placing what Materialize doesn't (a chat's conversation).
func DownloadArtifact(ctx context.Context, url, dst string) error {
	if url == "" {
		return fmt.Errorf("no download URL")
	}
	return download(ctx, url, "", dst)
}

// download streams a signed URL to dst, decompressing a gzip-encoded one.
func download(ctx context.Context, url, encoding, dst string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("unexpected status %d: %s", resp.StatusCode, body)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	var body io.Reader = resp.Body
	switch encoding {
	case "":
	case "gzip":
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			return fmt.Errorf("decompress: %w", err)
		}
		defer gz.Close()
		body = gz
	default:
		return fmt.Errorf("unknown encoding %q", encoding)
	}
	if _, err := io.Copy(f, body); err != nil {
		return err
	}
	return nil
}

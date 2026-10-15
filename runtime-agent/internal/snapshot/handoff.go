package snapshot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"runtime-agent/internal/protocol"
)

// A handoff package carries one session to another machine, where a new session
// continues it: the branch's own commits (a git bundle), its uncommitted work
// (a patch, untracked files included) and, when asked, Claude's conversation.
// Unlike an archive, packing leaves the session running, and the session it
// seeds is a new one, on a branch of its own, so the two carry on side by side.

// HandoffVersion is the package format's version; a seed refuses any other.
const HandoffVersion = 1

// handoffPayloads are the files a package may carry besides its manifest, in
// upload order. Only the patch is always there.
var handoffPayloads = []string{"bundle", "patch", "conversation"}

// ErrNoCommit refuses to pack a folder with no commit, or one that isn't a git
// repository: there is no HEAD for the other side to start from.
var ErrNoCommit = errors.New("this folder has no git commit to continue from: commit your work first, then try again")

// PackInput is a session to pack and where its files go.
type PackInput struct {
	// From is where the session runs: "local" or "cloud".
	From       string
	Title      string
	Worktree   string
	BaseBranch string
	// ConversationPath is Claude's transcript to take along; empty leaves the
	// chat behind.
	ConversationPath string
	Uploads          []protocol.HandoffFile
}

// Pack builds a session's handoff package and uploads it, the manifest last
// (its arrival marks the package complete). The bundle holds only the commits
// the base branch on GitHub lacks, so it stays small; with none, there is no
// bundle and the receiver starts from Head, which GitHub already has.
func Pack(ctx context.Context, in PackInput) (*protocol.HandoffManifest, error) {
	urls := map[string]string{}
	for _, up := range in.Uploads {
		if up.Artifact != "manifest" && !contains(handoffPayloads, up.Artifact) {
			return nil, fmt.Errorf("upload requested for unknown handoff file %q", up.Artifact)
		}
		urls[up.Artifact] = up.URL
	}
	for _, need := range []string{"patch", "manifest"} {
		if urls[need] == "" {
			return nil, fmt.Errorf("export request is missing the %s upload URL", need)
		}
	}
	head := lastCommit(ctx, in.Worktree)
	if head == nil {
		return nil, ErrNoCommit
	}

	staging, err := os.MkdirTemp("", "handoff-")
	if err != nil {
		return nil, fmt.Errorf("handoff staging dir: %w", err)
	}
	defer os.RemoveAll(staging)

	m := &protocol.HandoffManifest{
		Version:    HandoffVersion,
		From:       in.From,
		Title:      in.Title,
		BaseBranch: in.BaseBranch,
		Head:       *head,
		Worktree:   in.Worktree,
	}
	files := map[string]string{}

	bundle, err := buildBranchBundle(ctx, in.Worktree, in.BaseBranch, filepath.Join(staging, BundleName))
	if err != nil {
		return nil, err
	}
	if bundle != "" {
		if urls["bundle"] == "" {
			return nil, fmt.Errorf("export request is missing the bundle upload URL")
		}
		files["bundle"] = bundle
	}
	patch, err := buildPatch(ctx, in.Worktree, filepath.Join(staging, PatchName))
	if err != nil {
		return nil, err
	}
	files["patch"] = patch
	if in.ConversationPath != "" {
		if urls["conversation"] == "" {
			return nil, fmt.Errorf("export request is missing the conversation upload URL")
		}
		conversation, err := stageWholeLines(in.ConversationPath, filepath.Join(staging, ConversationName))
		if err != nil {
			return nil, err
		}
		id := strings.TrimSuffix(filepath.Base(in.ConversationPath), filepath.Ext(in.ConversationPath))
		m.ClaudeSessionID = &id
		files["conversation"] = conversation
	}

	for _, artifact := range handoffPayloads {
		path, ok := files[artifact]
		if !ok {
			continue
		}
		sum, size, err := checksumFile(path)
		if err != nil {
			return nil, err
		}
		checksum := &protocol.HandoffChecksum{SHA256: sum, Size: size}
		switch artifact {
		case "bundle":
			m.Bundle = checksum
		case "patch":
			m.Patch = *checksum
		case "conversation":
			m.Conversation = checksum
		}
	}
	manifestPath := filepath.Join(staging, "handoff.json")
	if err := writeJSON(manifestPath, m); err != nil {
		return nil, err
	}

	for _, artifact := range handoffPayloads {
		if path, ok := files[artifact]; ok {
			if err := putFile(ctx, urls[artifact], path); err != nil {
				return nil, fmt.Errorf("upload %s: %w", artifact, err)
			}
		}
	}
	if err := putFile(ctx, urls["manifest"], manifestPath); err != nil {
		return nil, fmt.Errorf("upload manifest: %w", err)
	}
	return m, nil
}

// buildBranchBundle bundles HEAD's history minus what origin/<base> already
// holds, the part GitHub, and so the receiver, has. It returns "" when there is
// nothing of the branch's own to carry. Without that remote branch it bundles
// HEAD's whole history: correct, only bigger.
func buildBranchBundle(ctx context.Context, worktree, baseBranch, dst string) (string, error) {
	args := []string{"-C", worktree, "bundle", "create", dst, "HEAD"}
	if base := "refs/remotes/origin/" + baseBranch; baseBranch != "" && refExists(ctx, worktree, base) {
		out, err := exec.CommandContext(ctx, "git", "-C", worktree, "rev-list", "--count", base+"..HEAD").Output()
		if err != nil {
			return "", fmt.Errorf("count the branch's commits: %w", err)
		}
		if strings.TrimSpace(string(out)) == "0" {
			return "", nil
		}
		args = append(args, "^"+base)
	}
	if out, err := exec.CommandContext(ctx, "git", args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("git bundle: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return dst, nil
}

func refExists(ctx context.Context, repo, ref string) bool {
	return exec.CommandContext(ctx, "git", "-C", repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}").Run() == nil
}

// stageWholeLines copies a transcript up to its last complete line. Claude
// appends to it as it works, so a copy made mid-write could end in half a
// line, which the other side would choke on when it continues the chat.
func stageWholeLines(src, dst string) (string, error) {
	data, err := os.ReadFile(src)
	if err != nil {
		return "", fmt.Errorf("read the conversation: %w", err)
	}
	if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
		data = data[:i+1]
	} else {
		data = nil
	}
	if len(data) == 0 {
		return "", fmt.Errorf("the conversation is empty")
	}
	return dst, os.WriteFile(dst, data, 0o600)
}

// SeedInput is a new workspace to start from a handoff package.
type SeedInput struct {
	// Repo is the repository the worktree is added to: the computer's mirror,
	// or the user's clone on a Mac.
	Repo     string
	Worktree string
	// Branch is the new workspace's own branch, made at the package's Head.
	Branch    string
	Manifest  protocol.HandoffManifest
	Downloads []protocol.HandoffFile
	// ConversationDest names where the transcript goes for Claude to continue
	// it, asked once the worktree exists: Claude files a transcript under its
	// folder's real path, symlinks resolved. Unused without a conversation.
	ConversationDest func() (string, error)
}

var shaHex = regexp.MustCompile(`^[0-9a-f]{40}$`)

// CheckManifest refuses a manifest this agent can't seed from, before any of
// it is acted on.
func CheckManifest(m protocol.HandoffManifest) error {
	if m.Version != HandoffVersion {
		return fmt.Errorf("unsupported handoff version %d", m.Version)
	}
	if !shaHex.MatchString(m.Head) {
		return fmt.Errorf("invalid handoff head %q", m.Head)
	}
	if m.Patch.SHA256 == "" {
		return fmt.Errorf("the handoff has no patch checksum")
	}
	if (m.Conversation == nil) != (m.ClaudeSessionID == nil) {
		return fmt.Errorf("the handoff's conversation and session id don't match")
	}
	return nil
}

// Seed makes the new workspace's worktree from a package: its branch at the
// package's Head (fetched from the bundle, or already in Repo), the uncommitted
// work applied on top, and the conversation where Claude will look for it.
// Every download is checked against the manifest's checksum first. On failure
// it removes what it made, so a retry starts clean.
func Seed(ctx context.Context, in SeedInput) (err error) {
	m := in.Manifest
	if err := CheckManifest(m); err != nil {
		return err
	}
	urls := map[string]string{}
	for _, d := range in.Downloads {
		urls[d.Artifact] = d.URL
	}
	staging, err := os.MkdirTemp("", "seed-")
	if err != nil {
		return fmt.Errorf("seed staging dir: %w", err)
	}
	defer os.RemoveAll(staging)

	if m.Bundle != nil {
		bundle := filepath.Join(staging, BundleName)
		if err := downloadChecked(ctx, urls["bundle"], bundle, *m.Bundle); err != nil {
			return fmt.Errorf("download bundle: %w", err)
		}
		ref := "+HEAD:refs/heads/" + in.Branch
		if out, err := exec.CommandContext(ctx, "git", "-C", in.Repo, "fetch", "--no-tags", bundle, ref).CombinedOutput(); err != nil {
			return fmt.Errorf("import bundle: %v: %s", err, strings.TrimSpace(string(out)))
		}
	} else {
		if exec.CommandContext(ctx, "git", "-C", in.Repo, "cat-file", "-e", m.Head+"^{commit}").Run() != nil {
			return fmt.Errorf("this copy of the repository has no commit %s: push %s and try again", m.Head[:12], m.BaseBranch)
		}
		if out, err := exec.CommandContext(ctx, "git", "-C", in.Repo, "branch", in.Branch, m.Head).CombinedOutput(); err != nil {
			return fmt.Errorf("create branch: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	defer func() {
		if err != nil {
			removeWorktree(ctx, in.Repo, in.Worktree)
			_ = exec.CommandContext(ctx, "git", "-C", in.Repo, "branch", "-D", in.Branch).Run()
		}
	}()
	out, err := exec.CommandContext(ctx, "git", "-C", in.Repo, "rev-parse", "refs/heads/"+in.Branch).Output()
	if err != nil || strings.TrimSpace(string(out)) != m.Head {
		return fmt.Errorf("the new branch isn't at the handoff's commit %s", m.Head[:12])
	}
	if err := addWorktree(ctx, in.Repo, in.Worktree, in.Branch); err != nil {
		return err
	}
	patch := filepath.Join(staging, PatchName)
	if err := downloadChecked(ctx, urls["patch"], patch, m.Patch); err != nil {
		return fmt.Errorf("download patch: %w", err)
	}
	if err := applyPatch(ctx, in.Worktree, patch); err != nil {
		return err
	}
	if m.Conversation != nil {
		if in.ConversationDest == nil {
			return fmt.Errorf("no place to put the conversation")
		}
		dest, err := in.ConversationDest()
		if err != nil {
			return err
		}
		if err := downloadChecked(ctx, urls["conversation"], dest, *m.Conversation); err != nil {
			return fmt.Errorf("download conversation: %w", err)
		}
	}
	return nil
}

// downloadChecked downloads a package file and refuses it unless it is the one
// the manifest describes, removing what it wrote.
func downloadChecked(ctx context.Context, url, dst string, want protocol.HandoffChecksum) error {
	if url == "" {
		return fmt.Errorf("no download URL")
	}
	if err := download(ctx, url, dst); err != nil {
		return err
	}
	sum, size, err := checksumFile(dst)
	if err != nil {
		return err
	}
	if sum != want.SHA256 || size != want.Size {
		_ = os.Remove(dst)
		return fmt.Errorf("checksum mismatch")
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

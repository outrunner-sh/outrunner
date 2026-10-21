package localimport

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"runtime-agent/internal/codex"
	"runtime-agent/internal/snapshot"
)

const (
	// MaxBundleBytes and MaxPatchBytes are the largest history and
	// uncommitted change imported.
	MaxBundleBytes = 1 << 30
	MaxPatchBytes  = 100 << 20
)

// EncodingGzip marks an artifact stored gzip-compressed.
const EncodingGzip = "gzip"

// Artifact is one file a capture wrote, as it is to be uploaded.
type Artifact struct {
	// Name is the Snapshot artifact it is (snapshot.BundleName, …).
	Name string `json:"name"`
	// Path is where it was written.
	Path string `json:"path"`
	// SHA256 is the stored bytes' digest, "sha256:<hex>".
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	Encoding string `json:"encoding,omitempty"`
}

// Capture is one session made into a Snapshot's artifacts.
type Capture struct {
	Session Session `json:"session"`
	// LastCommit is the branch's tip.
	LastCommit string `json:"lastCommit"`
	// ChangedFiles counts the files the uncommitted patch changes.
	ChangedFiles int `json:"changedFiles"`
	// Artifacts are keyed by kind: bundle, patch, conversation, and a Codex
	// session's rollout.
	Artifacts map[string]Artifact `json:"artifacts"`
}

// SkipError is a session that can't be captured, and why.
type SkipError struct{ Skip Skip }

func (e *SkipError) Error() string {
	if e.Skip.Detail != "" {
		return e.Skip.Reason + ": " + e.Skip.Detail
	}
	return e.Skip.Reason
}

// ErrNotFound is a key no session on this Mac has.
var ErrNotFound = errors.New("no session with that key is on this Mac any more")

// CaptureSession finds the session with key again and writes its artifacts
// into out:
//   - the branch's commits that are on no remote, as a git bundle (or its tip
//     alone, when every commit is pushed): the box's mirror has the rest;
//   - the checkout's uncommitted changes, when it is on the session's branch;
//   - the conversation, and a Codex session's raw rollout.
//
// The checkout is only read: its index and refs are left as they are.
func CaptureSession(ctx context.Context, opts Options, key, out string) (Capture, error) {
	s, ok := Locate(ctx, opts, key)
	if !ok {
		return Capture{}, ErrNotFound
	}
	if s.Skip != nil {
		return Capture{}, &SkipError{Skip: *s.Skip}
	}
	tip, err := git(ctx, s.Worktree, "rev-parse", "--verify", "refs/heads/"+s.Branch+"^{commit}")
	if err != nil {
		return Capture{}, &SkipError{Skip: Skip{Reason: SkipBranchMissing, Detail: "branch " + s.Branch + " is gone"}}
	}
	c := Capture{Session: s, LastCommit: tip, Artifacts: map[string]Artifact{}}

	bundle, err := writeBundle(ctx, s.Worktree, s.Branch, filepath.Join(out, snapshot.BundleName))
	if err != nil {
		return Capture{}, err
	}
	c.Artifacts["bundle"] = bundle

	var patch []byte
	if s.CheckedOut {
		patch = snapshot.WorkingPatch(ctx, s.Worktree)
	}
	if len(patch) > MaxPatchBytes {
		return Capture{}, &SkipError{Skip: Skip{Reason: SkipTooLarge, Detail: "the uncommitted changes are over 100 MB"}}
	}
	c.ChangedFiles = changedFiles(patch)
	if c.Artifacts["patch"], err = writeGzip(out, snapshot.PatchName, bytes.NewReader(patch)); err != nil {
		return Capture{}, err
	}

	if s.Agent == AgentCodex {
		if c.Artifacts["conversation"], err = writeCodexConversation(out, s.Transcript); err != nil {
			return Capture{}, err
		}
		if c.Artifacts["rollout"], err = writeGzipFile(out, snapshot.RolloutName, s.Transcript); err != nil {
			return Capture{}, err
		}
	} else if c.Artifacts["conversation"], err = writeGzipFile(out, snapshot.ConversationName, s.Transcript); err != nil {
		return Capture{}, err
	}
	return c, nil
}

// writeBundle bundles the branch's commits that are on no remote. With none
// (all pushed), git refuses an empty bundle, so the tip alone is bundled: the
// box fetches its parents from GitHub. A remote-tracking ref can be stale (a
// branch force-pushed since), which Restore reports as a missing commit.
func writeBundle(ctx context.Context, worktree, branch, dst string) (Artifact, error) {
	ref := "refs/heads/" + branch
	attempts := [][]string{
		{"bundle", "create", dst, ref, "--not", "--remotes"},
		{"bundle", "create", dst, "--max-count=1", ref},
	}
	var lastErr error
	for _, args := range attempts {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", worktree}, args...)...)
		out, err := cmd.CombinedOutput()
		if err == nil {
			lastErr = nil
			break
		}
		lastErr = fmt.Errorf("git bundle: %v: %s", err, strings.TrimSpace(string(out)))
		if !strings.Contains(string(out), "empty bundle") {
			break
		}
	}
	if lastErr != nil {
		return Artifact{}, lastErr
	}
	sum, size, err := fileDigest(dst)
	if err != nil {
		return Artifact{}, err
	}
	if size > MaxBundleBytes {
		return Artifact{}, &SkipError{Skip: Skip{Reason: SkipTooLarge, Detail: "the branch's unpushed history is over 1 GB"}}
	}
	return Artifact{Name: snapshot.BundleName, Path: dst, SHA256: sum, Size: size}, nil
}

// writeCodexConversation translates a rollout into the Claude-shaped log a
// Codex session's conversation is shown and archived as.
func writeCodexConversation(out, rollout string) (Artifact, error) {
	file, err := os.Open(rollout)
	if err != nil {
		return Artifact{}, err
	}
	defer file.Close()
	pr, pw := io.Pipe()
	go func() {
		tr := codex.NewTranslator()
		reader := bufio.NewReader(file)
		var offset int64
		var werr error
		write := func(recs []codex.Record) {
			for _, rec := range recs {
				if werr == nil {
					_, werr = pw.Write(rec.Line)
				}
			}
		}
		for werr == nil {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				write(tr.Line(offset, line))
			}
			offset += int64(len(line))
			if err != nil {
				if err != io.EOF {
					werr = err
				}
				break
			}
		}
		write(tr.Flush())
		pw.CloseWithError(werr)
	}()
	return writeGzip(out, snapshot.ConversationName, pr)
}

// writeGzipFile stores a file gzip-compressed.
func writeGzipFile(out, name, src string) (Artifact, error) {
	file, err := os.Open(src)
	if err != nil {
		return Artifact{}, err
	}
	defer file.Close()
	return writeGzip(out, name, file)
}

// writeGzip compresses r into out/<name>.gz, hashing what is stored as it is
// written: nothing is held in memory.
func writeGzip(out, name string, r io.Reader) (Artifact, error) {
	path := filepath.Join(out, name+".gz")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Artifact{}, err
	}
	digest := sha256.New()
	counted := &countingWriter{w: io.MultiWriter(file, digest)}
	gz := gzip.NewWriter(counted)
	_, err = io.Copy(gz, r)
	if cerr := gz.Close(); err == nil {
		err = cerr
	}
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return Artifact{}, fmt.Errorf("write %s: %w", name, err)
	}
	return Artifact{Name: name, Path: path, SHA256: digestString(digest), Size: counted.n, Encoding: EncodingGzip}, nil
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func fileDigest(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return "", 0, err
	}
	return digestString(digest), size, nil
}

func digestString(h hash.Hash) string { return "sha256:" + hex.EncodeToString(h.Sum(nil)) }

// changedFiles counts the files a patch changes.
func changedFiles(patch []byte) int {
	n := bytes.Count(patch, []byte("\ndiff --git "))
	if bytes.HasPrefix(patch, []byte("diff --git ")) {
		n++
	}
	return n
}

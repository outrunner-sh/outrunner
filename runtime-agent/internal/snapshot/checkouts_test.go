package snapshot

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/protocol"
)

// checkoutRepo makes folder/name a repository on branch "work": a commit,
// then an uncommitted edit and an untracked file holding marker.
func checkoutRepo(t *testing.T, folder, name, marker string) {
	t.Helper()
	dir := filepath.Join(folder, name)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run("init", "-q", "-b", "work")
	_ = os.WriteFile(filepath.Join(dir, "README"), []byte(name+" committed\n"), 0o644)
	run("add", "-A")
	run("commit", "-q", "-m", "init")
	_ = os.WriteFile(filepath.Join(dir, "README"), []byte(name+" wip "+marker+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "new.txt"), []byte(marker+"\n"), 0o644)
}

// A session of several repositories round-trips: each checkout's commits,
// uncommitted edits and untracked files come back in its own folder, off its
// own mirror, and the manifest lists them.
func TestCheckoutsRoundTrip(t *testing.T) {
	ctx := context.Background()
	folder := t.TempDir()
	checkoutRepo(t, folder, "web", "W")
	checkoutRepo(t, folder, "api", "A")

	up := newUploadServer()
	defer up.Close()
	manifest, err := Produce(ctx, Input{
		WorkspaceID: "ws",
		Worktree:    folder,
		Checkouts: []Checkout{
			{Name: "web", FullName: "acme/web", BaseBranch: "main"},
			{Name: "api", FullName: "acme/api", BaseBranch: "develop"},
		},
		Summary:    protocol.WorkspaceSummary{StartedAt: "2026-10-27T00:00:00Z"},
		ArchivedAt: "2026-10-27T01:00:00Z",
		Uploads:    allArtifactUploads(up.URL),
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Tree.Kind != TreeKindCheckouts || len(manifest.Tree.Checkouts) != 2 ||
		manifest.Tree.Checkouts[1].Name != "api" || manifest.Tree.Checkouts[1].LastCommit == nil || manifest.LastCommit != nil {
		data, _ := json.Marshal(manifest.Tree)
		t.Fatalf("tree = %s", data)
	}

	srv := artifactServer(t, map[string]string{
		"/bundle":       string(up.received["bundle"]),
		"/patch":        string(up.received["patch"]),
		"/conversation": "{}\n",
	})
	restored := filepath.Join(t.TempDir(), "ws")
	mirrors := map[string]string{"web": bareMirror(t), "api": bareMirror(t)}
	err = Materialize(ctx, MaterializeInput{
		WorktreePath: restored,
		Branch:       "work",
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: srv.URL + "/bundle"},
			{Artifact: "patch", URL: srv.URL + "/patch"},
		},
		Checkouts: []Checkout{{Name: "web", MirrorPath: mirrors["web"]}, {Name: "api", MirrorPath: mirrors["api"]}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, marker := range map[string]string{"web": "W", "api": "A"} {
		dir := filepath.Join(restored, name)
		if got := readFile(t, filepath.Join(dir, "README")); got != name+" wip "+marker+"\n" {
			t.Errorf("%s README = %q", name, got)
		}
		if got := readFile(t, filepath.Join(dir, "new.txt")); got != marker+"\n" {
			t.Errorf("%s new.txt = %q", name, got)
		}
		out, _ := exec.Command("git", "-C", dir, "symbolic-ref", "--short", "HEAD").Output()
		if strings.TrimSpace(string(out)) != "work" {
			t.Errorf("%s branch = %q", name, out)
		}
		common, _ := exec.Command("git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir").Output()
		if strings.TrimSpace(string(common)) != mirrors[name] {
			t.Errorf("%s is off %s, want its own mirror %s", name, common, mirrors[name])
		}
	}

	// Restoring again (a retry) converges.
	if err := Materialize(ctx, MaterializeInput{
		WorktreePath: restored, Branch: "work",
		Downloads: []protocol.RestoreDownload{{Artifact: "bundle", URL: srv.URL + "/bundle"}, {Artifact: "patch", URL: srv.URL + "/patch"}},
		Checkouts: []Checkout{{Name: "web", MirrorPath: mirrors["web"]}, {Name: "api", MirrorPath: mirrors["api"]}},
	}); err != nil {
		t.Fatalf("again: %v", err)
	}
}

// A tar entry that isn't one of the checkouts' files is never written, and a
// checkout name that could climb out of the folder is refused.
func TestCheckoutTarsTakeOnlyTheirOwnFiles(t *testing.T) {
	src := t.TempDir()
	for _, name := range []string{"web.bundle", "evil.bundle"} {
		_ = os.WriteFile(filepath.Join(src, name), []byte("x"), 0o644)
	}
	tarPath := filepath.Join(t.TempDir(), "b.tar")
	if err := writeTar(tarPath, []string{filepath.Join(src, "web.bundle"), filepath.Join(src, "evil.bundle")}); err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	if err := extractTar(tarPath, out, map[string]bool{"web.bundle": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "evil.bundle")); err == nil {
		t.Error("an entry nobody asked for was written")
	}
	if err := validCheckouts([]Checkout{{Name: "../x"}}); err == nil {
		t.Error("a checkout name with .. was accepted")
	}
}

// A Snapshot taken before the session's branch was renamed restores under
// the new name: the tree records the bundle's, and restore brings it back
// onto the branch the session has now.
func TestASnapshotFromBeforeARenameRestoresOntoTheNewName(t *testing.T) {
	ctx := context.Background()
	folder := t.TempDir()
	checkoutRepo(t, folder, "web", "W")
	checkoutRepo(t, folder, "api", "A")

	up := newUploadServer()
	defer up.Close()
	manifest, err := Produce(ctx, Input{
		WorkspaceID: "ws",
		Worktree:    folder,
		Branch:      "work",
		Checkouts:   []Checkout{{Name: "web", FullName: "acme/web", BaseBranch: "main"}, {Name: "api", FullName: "acme/api", BaseBranch: "main"}},
		Summary:     protocol.WorkspaceSummary{StartedAt: "2026-10-27T00:00:00Z"},
		ArchivedAt:  "2026-10-27T01:00:00Z",
		Uploads:     allArtifactUploads(up.URL),
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Tree.Ref != "work" {
		t.Fatalf("tree ref = %q, want the branch at the Snapshot", manifest.Tree.Ref)
	}

	srv := artifactServer(t, map[string]string{
		"/bundle":       string(up.received["bundle"]),
		"/patch":        string(up.received["patch"]),
		"/conversation": "{}\n",
	})
	restored := filepath.Join(t.TempDir(), "ws")
	err = Materialize(ctx, MaterializeInput{
		WorktreePath: restored,
		Branch:       "feat/renamed",
		BundleRef:    manifest.Tree.Ref,
		Downloads: []protocol.RestoreDownload{
			{Artifact: "bundle", URL: srv.URL + "/bundle"},
			{Artifact: "patch", URL: srv.URL + "/patch"},
		},
		Checkouts: []Checkout{{Name: "web", MirrorPath: bareMirror(t)}, {Name: "api", MirrorPath: bareMirror(t)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, marker := range map[string]string{"web": "W", "api": "A"} {
		dir := filepath.Join(restored, name)
		if got := readFile(t, filepath.Join(dir, "README")); got != name+" wip "+marker+"\n" {
			t.Errorf("%s README = %q", name, got)
		}
		out, _ := exec.Command("git", "-C", dir, "symbolic-ref", "--short", "HEAD").Output()
		if strings.TrimSpace(string(out)) != "feat/renamed" {
			t.Errorf("%s branch = %q", name, out)
		}
	}
}

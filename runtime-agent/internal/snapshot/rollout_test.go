package snapshot

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"runtime-agent/internal/protocol"
)

// A Codex session's raw rollout is an optional artifact: uploaded (before the
// manifest, which names it) only when the archive asks for it and the session
// has one.
func TestProduceUploadsARolloutOnlyWhenAskedAndPresent(t *testing.T) {
	rollout := filepath.Join(t.TempDir(), "rollout-x.jsonl")
	if err := os.WriteFile(rollout, []byte(`{"type":"session_meta"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name        string
		rolloutPath string
		askedFor    bool
		want        bool
	}{
		{"asked, and the session has one", rollout, true, true},
		{"not asked (an agent's older control plane)", rollout, false, false},
		{"asked of a Claude session", "", true, false},
		{"asked, but the rollout is gone", filepath.Join(t.TempDir(), "gone.jsonl"), true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := newUploadServer()
			defer srv.Close()
			uploads := allArtifactUploads(srv.URL)
			if c.askedFor {
				uploads = append(uploads, protocol.ArchiveUpload{Artifact: "rollout", URL: srv.URL + "/rollout"})
			}
			manifest, err := Produce(context.Background(), Input{
				WorkspaceID: "ws-1", Worktree: gitRepoWithWIP(t), ArchivedAt: "2026-10-20T00:00:00Z",
				RolloutPath: c.rolloutPath, Uploads: uploads,
			})
			if err != nil {
				t.Fatalf("Produce: %v", err)
			}
			_, uploaded := srv.received["rollout"]
			if uploaded != c.want || (manifest.Rollout == RolloutName) != c.want {
				t.Fatalf("rollout uploaded = %v, manifest names %q; want %v", uploaded, manifest.Rollout, c.want)
			}
			if srv.order[len(srv.order)-1] != "manifest" {
				t.Errorf("upload order = %v, want the manifest last", srv.order)
			}
			if c.want {
				if manifest.Checksums[RolloutName] != sha256Of(srv.received["rollout"]) {
					t.Error("the rollout's checksum is missing or wrong")
				}
				if slices.Index(srv.order, "rollout") > slices.Index(srv.order, "manifest") {
					t.Error("the rollout was uploaded after the manifest naming it")
				}
			}
		})
	}
}

func TestMaterializePlacesARolloutWhenTheSnapshotHasOne(t *testing.T) {
	bundle, patch := archivedRepo(t)
	const rollout = `{"type":"session_meta","payload":{"id":"s1"}}` + "\n"
	srv := artifactServer(t, map[string]string{
		"/bundle":  readFile(t, bundle),
		"/patch":   readFile(t, patch),
		"/rollout": rollout,
	})
	dest := filepath.Join(t.TempDir(), "codex", "sessions", "2026", "10", "20", "rollout-s1.jsonl")
	downloads := []protocol.RestoreDownload{
		{Artifact: "bundle", URL: srv.URL + "/bundle"},
		{Artifact: "patch", URL: srv.URL + "/patch"},
	}
	// Without a rollout download, nothing is placed and nothing fails.
	if err := Materialize(context.Background(), MaterializeInput{
		MirrorPath: bareMirror(t), WorktreePath: filepath.Join(t.TempDir(), "ws"), Branch: "feature",
		RolloutDest: dest, Downloads: downloads,
	}); err != nil {
		t.Fatalf("Materialize without a rollout: %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("a rollout was placed from nothing: %v", err)
	}
	if err := Materialize(context.Background(), MaterializeInput{
		MirrorPath: bareMirror(t), WorktreePath: filepath.Join(t.TempDir(), "ws"), Branch: "feature",
		RolloutDest: dest, Downloads: append(downloads, protocol.RestoreDownload{Artifact: "rollout", URL: srv.URL + "/rollout"}),
	}); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got := readFile(t, dest); got != rollout {
		t.Errorf("rollout placed = %q", got)
	}
}

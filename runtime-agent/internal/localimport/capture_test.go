package localimport

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/snapshot"
)

// A session captured on a Mac restores on a box that has never seen the
// checkout: a mirror cloned from GitHub, plus the capture's artifacts. The
// checkout itself is left exactly as it was.
func TestCaptureRestoresOnAFreshBox(t *testing.T) {
	cases := []struct {
		name string
		// setup puts the clone on branch "feature" as the case needs and
		// returns the files the restored worktree must have.
		setup func(t *testing.T, clone, origin string) map[string]string
	}{
		{
			name: "unpushed commits and uncommitted work",
			setup: func(t *testing.T, clone, _ string) map[string]string {
				gitIn(t, clone, "checkout", "-q", "-b", "feature")
				writeFile(t, filepath.Join(clone, "app.txt"), "v2\n")
				gitIn(t, clone, "commit", "-q", "-am", "v2")
				writeFile(t, filepath.Join(clone, "app.txt"), "v2 wip\n")
				writeFile(t, filepath.Join(clone, "notes.txt"), "untracked\n")
				return map[string]string{"app.txt": "v2 wip\n", "notes.txt": "untracked\n"}
			},
		},
		{
			name: "built on a branch that was never pushed",
			setup: func(t *testing.T, clone, _ string) map[string]string {
				gitIn(t, clone, "checkout", "-q", "-b", "local-base")
				writeFile(t, filepath.Join(clone, "base.txt"), "local only\n")
				gitIn(t, clone, "add", "-A")
				gitIn(t, clone, "commit", "-q", "-m", "local base")
				gitIn(t, clone, "checkout", "-q", "-b", "feature")
				writeFile(t, filepath.Join(clone, "feature.txt"), "feature\n")
				gitIn(t, clone, "add", "-A")
				gitIn(t, clone, "commit", "-q", "-m", "feature")
				return map[string]string{"base.txt": "local only\n", "feature.txt": "feature\n"}
			},
		},
		{
			name: "every commit already pushed",
			setup: func(t *testing.T, clone, origin string) map[string]string {
				gitIn(t, clone, "checkout", "-q", "-b", "feature")
				writeFile(t, filepath.Join(clone, "app.txt"), "pushed\n")
				gitIn(t, clone, "commit", "-q", "-am", "pushed")
				gitIn(t, clone, "push", "-q", origin, "feature")
				gitIn(t, clone, "update-ref", "refs/remotes/origin/feature", "HEAD")
				return map[string]string{"app.txt": "pushed\n"}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home, opts := testHome(t)
			clone := filepath.Join(home, "code", "app")
			if err := os.MkdirAll(filepath.Dir(clone), 0o755); err != nil {
				t.Fatal(err)
			}
			origin := repoWithOrigin(t, clone)
			want := tc.setup(t, clone, origin)
			conversation := writeClaudeSession(t, home, clone, "s-1",
				claudeLineJSON(t, "user", clone, "feature", "2026-10-20T10:00:00Z", "build the feature"),
				claudeLineJSON(t, "assistant", clone, "feature", "2026-10-20T10:01:00Z", "done"),
			)
			statusBefore := gitIn(t, clone, "status", "--porcelain")
			refsBefore := gitIn(t, clone, "for-each-ref")

			out := t.TempDir()
			c, err := CaptureSession(context.Background(), opts, "claude:s-1", out)
			if err != nil {
				t.Fatalf("CaptureSession: %v", err)
			}
			if c.Session.Repo != "ada/app" || c.Session.Branch != "feature" {
				t.Fatalf("captured %s on %s, want ada/app on feature", c.Session.Repo, c.Session.Branch)
			}

			// The box: a mirror of GitHub, which has none of the unpushed commits.
			box := t.TempDir()
			mirror := filepath.Join(box, "repo.git")
			gitIn(t, box, "clone", "-q", "--bare", origin, mirror)
			worktree := filepath.Join(box, "workspaces", "ws-1")
			restored := filepath.Join(box, "conversation.jsonl")
			err = snapshot.Materialize(context.Background(), snapshot.MaterializeInput{
				MirrorPath:       mirror,
				WorktreePath:     worktree,
				Branch:           c.Session.Branch,
				ConversationDest: restored,
				Downloads:        serveArtifacts(t, c),
			})
			if err != nil {
				t.Fatalf("Materialize: %v", err)
			}

			if got := gitIn(t, worktree, "rev-parse", "HEAD"); got != c.LastCommit {
				t.Errorf("restored HEAD %s, want the branch tip %s", got, c.LastCommit)
			}
			for name, content := range want {
				data, err := os.ReadFile(filepath.Join(worktree, name))
				if err != nil || string(data) != content {
					t.Errorf("restored %s = %q (%v), want %q", name, data, err, content)
				}
			}
			assertSameFile(t, restored, conversation)
			if got := gitIn(t, clone, "status", "--porcelain"); got != statusBefore {
				t.Errorf("the checkout's status changed:\n%s\nwas:\n%s", got, statusBefore)
			}
			if got := gitIn(t, clone, "for-each-ref"); got != refsBefore {
				t.Errorf("the checkout's refs changed:\n%s\nwas:\n%s", got, refsBefore)
			}
		})
	}
}

// serveArtifacts serves a capture's artifacts as signed URLs would, already
// decompressed: what Restore downloads once it reads a gzip-encoded artifact.
func serveArtifacts(t *testing.T, c Capture) []protocol.RestoreDownload {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, ok := c.Artifacts[r.URL.Path[1:]]
		if !ok {
			http.NotFound(w, r)
			return
		}
		file, err := os.Open(a.Path)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer file.Close()
		var body io.Reader = file
		if a.Encoding == EncodingGzip {
			gz, err := gzip.NewReader(file)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			body = gz
		}
		_, _ = io.Copy(w, body)
	}))
	t.Cleanup(server.Close)
	var downloads []protocol.RestoreDownload
	for kind := range c.Artifacts {
		downloads = append(downloads, protocol.RestoreDownload{Artifact: kind, URL: server.URL + "/" + kind})
	}
	return downloads
}

func assertSameFile(t *testing.T, got, want string) {
	t.Helper()
	a, err := os.ReadFile(got)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Errorf("%s differs from %s", got, want)
	}
}

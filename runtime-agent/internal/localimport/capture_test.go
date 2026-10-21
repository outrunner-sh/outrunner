package localimport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/snapshot"
)

// A session captured on a Mac restores on a box that has never seen the
// checkout: a mirror cloned from GitHub, plus the capture's artifacts as they
// are stored. Its conversation now works in the box's worktree, and the
// checkout itself is left exactly as it was.
func TestCaptureRestoresOnAFreshBox(t *testing.T) {
	cases := []struct {
		name string
		// restoreAs is the branch the box restores it on, when the import's
		// was taken in the cloud.
		restoreAs string
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
			name:      "restored under another branch name",
			restoreAs: "feature-imported",
			setup: func(t *testing.T, clone, _ string) map[string]string {
				gitIn(t, clone, "checkout", "-q", "-b", "feature")
				writeFile(t, filepath.Join(clone, "app.txt"), "renamed\n")
				gitIn(t, clone, "commit", "-q", "-am", "renamed")
				return map[string]string{"app.txt": "renamed\n"}
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
			writeClaudeSession(t, home, clone, "s-1",
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
			branch, bundleRef := c.Session.Branch, ""
			if tc.restoreAs != "" {
				branch, bundleRef = tc.restoreAs, c.Session.Branch
			}
			err = snapshot.Materialize(context.Background(), snapshot.MaterializeInput{
				MirrorPath:       mirror,
				WorktreePath:     worktree,
				Branch:           branch,
				BundleRef:        bundleRef,
				OriginWorktree:   c.Session.Worktree,
				ConversationDest: restored,
				Downloads:        serveArtifacts(t, c),
			})
			if err != nil {
				t.Fatalf("Materialize: %v", err)
			}

			if got := gitIn(t, worktree, "rev-parse", "HEAD"); got != c.LastCommit {
				t.Errorf("restored HEAD %s, want the branch tip %s", got, c.LastCommit)
			}
			if got := gitIn(t, worktree, "symbolic-ref", "--short", "HEAD"); got != branch {
				t.Errorf("restored on %s, want %s", got, branch)
			}
			for name, content := range want {
				data, err := os.ReadFile(filepath.Join(worktree, name))
				if err != nil || string(data) != content {
					t.Errorf("restored %s = %q (%v), want %q", name, data, err, content)
				}
			}
			assertConversationIn(t, restored, worktree, 2)
			if got := gitIn(t, clone, "status", "--porcelain"); got != statusBefore {
				t.Errorf("the checkout's status changed:\n%s\nwas:\n%s", got, statusBefore)
			}
			if got := gitIn(t, clone, "for-each-ref"); got != refsBefore {
				t.Errorf("the checkout's refs changed:\n%s\nwas:\n%s", got, refsBefore)
			}
		})
	}
}

// serveArtifacts serves a capture's artifacts as signed URLs would: the bytes
// stored, each download saying how they are encoded.
func serveArtifacts(t *testing.T, c Capture) []protocol.RestoreDownload {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, ok := c.Artifacts[r.URL.Path[1:]]
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, a.Path)
	}))
	t.Cleanup(server.Close)
	var downloads []protocol.RestoreDownload
	for kind, a := range c.Artifacts {
		downloads = append(downloads, protocol.RestoreDownload{Artifact: kind, URL: server.URL + "/" + kind, Encoding: a.Encoding})
	}
	return downloads
}

// assertConversationIn checks a restored conversation has its records and
// that every one now works in worktree.
func assertConversationIn(t *testing.T, path, worktree string, records int) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != records {
		t.Fatalf("restored %d records, want %d:\n%s", len(lines), records, data)
	}
	for _, line := range lines {
		var rec struct {
			Cwd string `json:"cwd"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil || rec.Cwd != worktree {
			t.Errorf("restored record works in %q (%v), want %q", rec.Cwd, err, worktree)
		}
	}
}

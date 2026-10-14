package workspace

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"runtime-agent/internal/protocol"
)

// bucket stands in for the storage the signed URLs point at.
func bucket(t *testing.T) (files func() []protocol.HandoffFile, stored map[string][]byte) {
	t.Helper()
	var mu sync.Mutex
	stored = map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		name := strings.TrimPrefix(r.URL.Path, "/")
		if r.Method == http.MethodPut {
			stored[name], _ = io.ReadAll(r.Body)
			return
		}
		body, ok := stored[name]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return func() []protocol.HandoffFile {
		var out []protocol.HandoffFile
		for _, name := range []string{"bundle", "patch", "conversation", "manifest"} {
			out = append(out, protocol.HandoffFile{Artifact: name, URL: srv.URL + "/" + name})
		}
		return out
	}, stored
}

const handoffSession = "11111111-2222-4333-8444-555555555555"

// macSessionWithWork is a local session on a clone of GitHub (origin) with a
// commit of its own, an uncommitted edit, and a conversation.
func macSessionWithWork(t *testing.T) (mac *Service, fake *fakeSessions, origin, worktree string) {
	t.Helper()
	isolateGit(t)
	t.Setenv("HOME", t.TempDir())
	origin = filepath.Join(t.TempDir(), "origin.git")
	run(t, filepath.Dir(origin), "clone", "--quiet", "--bare", newCheckout(t), origin)
	clone := filepath.Join(t.TempDir(), "app")
	run(t, filepath.Dir(clone), "clone", "--quiet", origin, clone)

	mac = NewService(t.TempDir())
	fake = newFakeSessions()
	mac.tmux = fake
	worktree, err := mac.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-mac", Branch: "runtime/abc-12345678", BaseBranch: "main", RepoPath: clone, Title: "Fix the login",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, worktree, "commit", "--quiet", "-am", "work")
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("not yet committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	log := filepath.Join(claudeProjectDir(home, worktree), handoffSession+".jsonl")
	if err := os.MkdirAll(filepath.Dir(log), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, []byte(`{"type":"user"}`+"\n"+`{"type":"assistant"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return mac, fake, origin, worktree
}

// cloudService is a Runtime Computer's agent, its mirror cloned from GitHub.
func cloudService(t *testing.T, origin string) *Service {
	t.Helper()
	root := t.TempDir()
	// As cloneMirror makes it (lib/runtime/git): GitHub's branches as origin/*.
	mirror := filepath.Join(root, "repo.git")
	run(t, root, "init", "--quiet", "--bare", mirror)
	run(t, mirror, "remote", "add", "origin", origin)
	run(t, mirror, "fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*")
	cloud := NewService(root)
	cloud.tmux = newFakeSessions()
	return cloud
}

func TestAMacSessionContinuesInTheCloudWithItsChatOnANewBranch(t *testing.T) {
	ctx := context.Background()
	mac, _, origin, macWorktree := macSessionWithWork(t)
	files, _ := bucket(t)

	m, err := mac.Export(ctx, "ws-mac", protocol.ExportWorkspaceRequest{WithChat: true, Uploads: files()})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if m.From != "local" || m.Title != "Fix the login" || m.BaseBranch != "main" || m.Worktree != macWorktree {
		t.Fatalf("manifest = %+v", m)
	}

	cloud := cloudService(t, origin)
	worktree, err := cloud.Create(ctx, CreateInput{
		WorkspaceID: "ws-cloud", Branch: "runtime/def-87654321", BaseBranch: "main",
		From: &protocol.SeedFrom{Manifest: *m, Downloads: files()},
	})
	if err != nil {
		t.Fatalf("Create from the package: %v", err)
	}
	if got := run(t, worktree, "rev-parse", "--abbrev-ref", "HEAD"); got != "runtime/def-87654321" {
		t.Errorf("branch = %s", got)
	}
	if got, _ := os.ReadFile(filepath.Join(worktree, "README.md")); string(got) != "not yet committed\n" {
		t.Errorf("README.md = %q", got)
	}
	f, _ := cloud.getFacts("ws-cloud")
	if f.ClaudeSessionID != handoffSession || f.Title != "Fix the login" {
		t.Errorf("facts = %+v", f)
	}
	if cloud.SessionLog("ws-cloud") == "" {
		t.Fatal("the conversation isn't where Claude looks for it")
	}
	// Claude resumes the conversation by its id, told where its files are now.
	launch := cloud.launchCommand("ws-cloud", worktree, true)
	if i := slices.Index(launch, "--resume"); i < 0 || launch[i+1] != handoffSession {
		t.Errorf("launch = %q, want --resume %s", launch, handoffSession)
	}
	if o := cloud.orientation("ws-cloud", worktree); !strings.Contains(o, "ran on the user's Mac, in "+macWorktree) || !strings.Contains(o, "here in "+worktree) {
		t.Errorf("orientation lacks the move:\n%s", o)
	}
	// The Mac session is untouched, and keeps its own branch.
	if got := run(t, macWorktree, "rev-parse", "--abbrev-ref", "HEAD"); got != "runtime/abc-12345678" {
		t.Errorf("the Mac session's branch = %s", got)
	}
}

func TestStartingFreshTakesTheCodeButNotTheChat(t *testing.T) {
	ctx := context.Background()
	mac, _, origin, _ := macSessionWithWork(t)
	files, stored := bucket(t)
	m, err := mac.Export(ctx, "ws-mac", protocol.ExportWorkspaceRequest{WithChat: false, Uploads: files()})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if m.Conversation != nil || stored["conversation"] != nil {
		t.Fatal("the chat went along")
	}
	cloud := cloudService(t, origin)
	worktree, err := cloud.Create(ctx, CreateInput{
		WorkspaceID: "ws-fresh", Branch: "runtime/fresh", BaseBranch: "main",
		From: &protocol.SeedFrom{Manifest: *m, Downloads: files()},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(worktree, "README.md")); string(got) != "not yet committed\n" {
		t.Errorf("README.md = %q", got)
	}
	launch := cloud.launchCommand("ws-fresh", worktree, false)
	if slices.Contains(launch, "--resume") || slices.Contains(launch, "--session-id") {
		t.Errorf("a fresh start launched %q", launch)
	}
	if o := cloud.orientation("ws-fresh", worktree); strings.Contains(o, "continues one") {
		t.Errorf("a fresh chat was told about earlier messages:\n%s", o)
	}
}

func TestExportWaitsForClaudeToFinish(t *testing.T) {
	mac, fake, _, _ := macSessionWithWork(t)
	files, _ := bucket(t)
	fake.running[sessionName("ws-mac")] = true
	fake.pane = "✻ Thinking… (esc to interrupt)"
	if _, err := mac.Export(context.Background(), "ws-mac", protocol.ExportWorkspaceRequest{Uploads: files()}); !errors.Is(err, ErrClaudeBusy) {
		t.Fatalf("Export mid-turn = %v, want ErrClaudeBusy", err)
	}
}

func TestASessionEditingAFolderInPlaceCantBeExported(t *testing.T) {
	s, _, id, _ := stoppedSession(t)
	files, _ := bucket(t)
	if _, err := s.Export(context.Background(), id, protocol.ExportWorkspaceRequest{Uploads: files()}); !errors.Is(err, ErrInPlaceExport) {
		t.Fatalf("Export = %v, want ErrInPlaceExport", err)
	}
}

func TestASeedThatFailsLeavesNoSessionBehind(t *testing.T) {
	ctx := context.Background()
	mac, _, origin, _ := macSessionWithWork(t)
	files, stored := bucket(t)
	m, err := mac.Export(ctx, "ws-mac", protocol.ExportWorkspaceRequest{Uploads: files()})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	stored["patch"] = []byte("tampered")
	cloud := cloudService(t, origin)
	if _, err := cloud.Create(ctx, CreateInput{
		WorkspaceID: "ws-bad", Branch: "runtime/bad", BaseBranch: "main",
		From: &protocol.SeedFrom{Manifest: *m, Downloads: files()},
	}); err == nil {
		t.Fatal("seeded from a tampered patch")
	}
	if _, ok := cloud.getFacts("ws-bad"); ok {
		t.Error("the failed session's facts were kept")
	}
	if _, err := os.Stat(cloud.worktreePath("ws-bad")); !os.IsNotExist(err) {
		t.Error("the failed session's worktree was kept")
	}
}

func TestASeedWithASessionIDThatEscapesIsRefused(t *testing.T) {
	cloud := NewService(t.TempDir())
	escape := "../../evil"
	m := protocol.HandoffManifest{
		Version: 1, Head: strings.Repeat("a", 40), Patch: protocol.HandoffChecksum{SHA256: "sha256:x"},
		ClaudeSessionID: &escape, Conversation: &protocol.HandoffChecksum{SHA256: "sha256:y"},
	}
	if _, err := cloud.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-x", Branch: "runtime/x", BaseBranch: "main", From: &protocol.SeedFrom{Manifest: m},
	}); err == nil || !strings.Contains(err.Error(), "invalid session id") {
		t.Fatalf("Create = %v, want an invalid session id", err)
	}
}

func TestGithubRepoReadsEveryKindOfGitHubRemote(t *testing.T) {
	for url, want := range map[string]string{
		"https://github.com/neevai-labs/outrunner.git":       "neevai-labs/outrunner",
		"https://github.com/neevai-labs/outrunner":           "neevai-labs/outrunner",
		"https://x-access-token@github.com/acme/site.io.git": "acme/site.io",
		"git@github.com:acme/my_repo.git":                    "acme/my_repo",
		"ssh://git@github.com/acme/app":                      "acme/app",
		"https://gitlab.com/acme/app.git":                    "",
		"/Users/ada/origin.git":                              "",
		"https://github.com/acme":                            "",
	} {
		if got := githubRepoFromURL(url); got != want {
			t.Errorf("githubRepoFromURL(%q) = %q, want %q", url, got, want)
		}
	}
}

package snapshot

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"runtime-agent/internal/protocol"
)

// storeServer stands in for the bucket: a PUT keeps a file's bytes, a GET
// returns them, as the signed URLs do.
type storeServer struct {
	*httptest.Server
	mu    sync.Mutex
	files map[string][]byte
	order []string
}

func newStoreServer(t *testing.T) *storeServer {
	t.Helper()
	s := &storeServer{files: map[string][]byte{}}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		s.mu.Lock()
		defer s.mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			s.files[name] = body
			s.order = append(s.order, name)
		case http.MethodGet:
			body, ok := s.files[name]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(body)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *storeServer) handoffFiles() []protocol.HandoffFile {
	var files []protocol.HandoffFile
	for _, name := range []string{"bundle", "patch", "conversation", "manifest"} {
		files = append(files, protocol.HandoffFile{Artifact: name, URL: s.URL + "/" + name})
	}
	return files
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// handoffRepos builds GitHub (a bare origin with main), a Mac clone of it, and
// a session worktree off origin/main on its own branch, as a local session has.
func handoffRepos(t *testing.T) (origin, clone, worktree string) {
	t.Helper()
	root := t.TempDir()
	seed := filepath.Join(root, "seed")
	if err := os.MkdirAll(seed, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, seed, "init", "-q", "-b", "main")
	write(t, filepath.Join(seed, "app.txt"), "v1\n")
	git(t, seed, "add", "-A")
	git(t, seed, "commit", "-q", "-m", "first")
	origin = filepath.Join(root, "origin.git")
	git(t, root, "clone", "-q", "--bare", seed, origin)
	clone = filepath.Join(root, "clone")
	git(t, root, "clone", "-q", origin, clone)
	worktree = filepath.Join(root, "workspaces", "ws-1")
	git(t, clone, "worktree", "add", "-q", "-b", "runtime/abc-12345678", worktree, "origin/main")
	return origin, clone, worktree
}

// cloudMirror is a computer's mirror of GitHub, made as cloneMirror makes it
// (lib/runtime/git): a bare repository with GitHub's branches as origin/*.
func cloudMirror(t *testing.T, origin string) string {
	t.Helper()
	mirror := filepath.Join(t.TempDir(), "repo.git")
	git(t, filepath.Dir(mirror), "init", "-q", "--bare", mirror)
	git(t, mirror, "remote", "add", "origin", origin)
	git(t, mirror, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*")
	return mirror
}

func TestPackCarriesTheBranchsCommitsWorkAndChatAndSeedRebuildsThemOnANewBranch(t *testing.T) {
	ctx := context.Background()
	origin, _, worktree := handoffRepos(t)
	// A commit of the session's own, then uncommitted work: an edit and a new file.
	write(t, filepath.Join(worktree, "app.txt"), "v2\n")
	git(t, worktree, "commit", "-q", "-am", "session work")
	write(t, filepath.Join(worktree, "app.txt"), "v3, not committed\n")
	write(t, filepath.Join(worktree, "notes/new.md"), "untracked\n")
	head := git(t, worktree, "rev-parse", "HEAD")
	// Claude is mid-way through writing its last line.
	chat := filepath.Join(t.TempDir(), "11111111-2222-4333-8444-555555555555.jsonl")
	write(t, chat, `{"type":"user"}`+"\n"+`{"type":"assistant"}`+"\n"+`{"type":"assis`)

	store := newStoreServer(t)
	m, err := Pack(ctx, PackInput{
		From: "local", Title: "Fix the login", Worktree: worktree, BaseBranch: "main",
		ConversationPath: chat, Uploads: store.handoffFiles(),
	})
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	if m.Head != head || m.Bundle == nil || m.Conversation == nil {
		t.Fatalf("manifest = %+v", m)
	}
	if m.ClaudeSessionID == nil || *m.ClaudeSessionID != "11111111-2222-4333-8444-555555555555" {
		t.Fatalf("session id = %v", m.ClaudeSessionID)
	}
	if last := store.order[len(store.order)-1]; last != "manifest" {
		t.Fatalf("uploaded %v: the manifest must go last", store.order)
	}
	// The session goes on: Pack leaves its work as it was.
	if got := readFile(t, filepath.Join(worktree, "app.txt")); got != "v3, not committed\n" {
		t.Fatalf("worktree changed: %q", got)
	}
	if status := git(t, worktree, "status", "--porcelain"); !strings.Contains(status, "?? notes/") {
		t.Fatalf("the new file was left staged: %q", status)
	}

	mirror := cloudMirror(t, origin)
	seeded := filepath.Join(t.TempDir(), "workspaces", "ws-2")
	dest := filepath.Join(t.TempDir(), "projects", "slug", *m.ClaudeSessionID+".jsonl")
	if err := Seed(ctx, SeedInput{
		Repo: mirror, Worktree: seeded, Branch: "runtime/def-87654321", Manifest: *m,
		Downloads: store.handoffFiles(), ConversationDest: func() (string, error) { return dest, nil },
	}); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if got := git(t, seeded, "rev-parse", "HEAD"); got != head {
		t.Fatalf("seeded HEAD = %s, want %s", got, head)
	}
	if got := git(t, seeded, "symbolic-ref", "--short", "HEAD"); got != "runtime/def-87654321" {
		t.Fatalf("seeded branch = %s", got)
	}
	if got := readFile(t, filepath.Join(seeded, "app.txt")); got != "v3, not committed\n" {
		t.Fatalf("uncommitted edit = %q", got)
	}
	if got := readFile(t, filepath.Join(seeded, "notes/new.md")); got != "untracked\n" {
		t.Fatalf("untracked file = %q", got)
	}
	// Whole lines only: the half-written one stayed behind.
	if got := readFile(t, dest); got != `{"type":"user"}`+"\n"+`{"type":"assistant"}`+"\n" {
		t.Fatalf("conversation = %q", got)
	}
}

func TestABranchWithNoCommitsOfItsOwnTravelsWithoutABundle(t *testing.T) {
	ctx := context.Background()
	origin, _, worktree := handoffRepos(t)
	write(t, filepath.Join(worktree, "app.txt"), "edited\n")
	store := newStoreServer(t)
	m, err := Pack(ctx, PackInput{From: "local", Worktree: worktree, BaseBranch: "main", Uploads: store.handoffFiles()})
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	if m.Bundle != nil || m.Conversation != nil || m.ClaudeSessionID != nil {
		t.Fatalf("manifest = %+v: no commits and no chat carry no bundle and no conversation", m)
	}
	if _, ok := store.files["bundle"]; ok {
		t.Fatal("a bundle was uploaded")
	}

	mirror := cloudMirror(t, origin)
	seeded := filepath.Join(t.TempDir(), "ws-2")
	if err := Seed(ctx, SeedInput{Repo: mirror, Worktree: seeded, Branch: "runtime/new", Manifest: *m, Downloads: store.handoffFiles()}); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if got := readFile(t, filepath.Join(seeded, "app.txt")); got != "edited\n" {
		t.Fatalf("app.txt = %q", got)
	}
}

func TestABaseBranchGitHubLacksSendsTheWholeHistory(t *testing.T) {
	ctx := context.Background()
	_, _, worktree := handoffRepos(t)
	write(t, filepath.Join(worktree, "app.txt"), "v2\n")
	git(t, worktree, "commit", "-q", "-am", "session work")
	store := newStoreServer(t)
	// The session targets a branch only the Mac has: nothing to subtract.
	m, err := Pack(ctx, PackInput{From: "local", Worktree: worktree, BaseBranch: "feat/never-pushed", Uploads: store.handoffFiles()})
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	if m.Bundle == nil {
		t.Fatal("no bundle")
	}
	// Even a repository with none of the history takes it.
	empty := filepath.Join(t.TempDir(), "empty.git")
	git(t, filepath.Dir(empty), "init", "-q", "--bare", empty)
	seeded := filepath.Join(t.TempDir(), "ws-2")
	if err := Seed(ctx, SeedInput{Repo: empty, Worktree: seeded, Branch: "runtime/new", Manifest: *m, Downloads: store.handoffFiles()}); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if got := readFile(t, filepath.Join(seeded, "app.txt")); got != "v2\n" {
		t.Fatalf("app.txt = %q", got)
	}
}

func TestSeedIntoAMacCloneWorksToo(t *testing.T) {
	ctx := context.Background()
	origin, _, worktree := handoffRepos(t)
	write(t, filepath.Join(worktree, "app.txt"), "v2\n")
	git(t, worktree, "commit", "-q", "-am", "cloud work")
	store := newStoreServer(t)
	m, err := Pack(ctx, PackInput{From: "cloud", Worktree: worktree, BaseBranch: "main", Uploads: store.handoffFiles()})
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	clone := filepath.Join(t.TempDir(), "mac-clone")
	git(t, filepath.Dir(clone), "clone", "-q", origin, clone)
	seeded := filepath.Join(t.TempDir(), "ws-3")
	if err := Seed(ctx, SeedInput{Repo: clone, Worktree: seeded, Branch: "runtime/mac", Manifest: *m, Downloads: store.handoffFiles()}); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if got := readFile(t, filepath.Join(seeded, "app.txt")); got != "v2\n" {
		t.Fatalf("app.txt = %q", got)
	}
}

func TestSeedRefusesAFileThatIsntTheOneTheManifestDescribesAndCleansUp(t *testing.T) {
	ctx := context.Background()
	origin, _, worktree := handoffRepos(t)
	write(t, filepath.Join(worktree, "app.txt"), "edited\n")
	store := newStoreServer(t)
	m, err := Pack(ctx, PackInput{From: "local", Worktree: worktree, BaseBranch: "main", Uploads: store.handoffFiles()})
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	store.files["patch"] = []byte("tampered")

	mirror := cloudMirror(t, origin)
	seeded := filepath.Join(t.TempDir(), "ws-2")
	err = Seed(ctx, SeedInput{Repo: mirror, Worktree: seeded, Branch: "runtime/new", Manifest: *m, Downloads: store.handoffFiles()})
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("Seed = %v, want a checksum error", err)
	}
	if _, err := os.Stat(seeded); !os.IsNotExist(err) {
		t.Fatal("the worktree was left behind")
	}
	if refExists(ctx, mirror, "refs/heads/runtime/new") {
		t.Fatal("the branch was left behind")
	}
}

func TestPackNeedsACommitAndThePatchAndManifestURLs(t *testing.T) {
	ctx := context.Background()
	_, _, worktree := handoffRepos(t)
	store := newStoreServer(t)
	if _, err := Pack(ctx, PackInput{Worktree: worktree, BaseBranch: "main", Uploads: store.handoffFiles()[3:]}); err == nil {
		t.Fatal("packed without a patch URL")
	}
	empty := t.TempDir()
	git(t, empty, "init", "-q")
	if _, err := Pack(ctx, PackInput{Worktree: empty, Uploads: store.handoffFiles()}); err != ErrNoCommit {
		t.Fatalf("Pack = %v, want ErrNoCommit", err)
	}
}

func TestCheckManifestRefusesWhatItCantSeedFrom(t *testing.T) {
	id := "11111111-2222-4333-8444-555555555555"
	good := protocol.HandoffManifest{
		Version: 1, Head: strings.Repeat("a", 40),
		Patch: protocol.HandoffChecksum{SHA256: "sha256:x"},
	}
	if err := CheckManifest(good); err != nil {
		t.Fatalf("good manifest: %v", err)
	}
	for name, m := range map[string]protocol.HandoffManifest{
		"a newer version": func() protocol.HandoffManifest { m := good; m.Version = 2; return m }(),
		"a bad head":      func() protocol.HandoffManifest { m := good; m.Head = "HEAD"; return m }(),
		"no patch":        func() protocol.HandoffManifest { m := good; m.Patch = protocol.HandoffChecksum{}; return m }(),
		"an id, no chat":  func() protocol.HandoffManifest { m := good; m.ClaudeSessionID = &id; return m }(),
		"a chat, no id": func() protocol.HandoffManifest {
			m := good
			m.Conversation = &protocol.HandoffChecksum{SHA256: "sha256:y"}
			return m
		}(),
	} {
		if CheckManifest(m) == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

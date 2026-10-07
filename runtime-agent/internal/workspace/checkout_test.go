package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// These run real git against throwaway repositories, because what matters is
// what git actually does to someone's checkout.

// isolateGit keeps the developer's own git config (signing, hooks, URL
// rewrites) out of the test. It must run before NewService, which snapshots
// the environment.
func isolateGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir,
		"-c", "user.name=Test", "-c", "user.email=test@example.com"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newCheckout makes a "user's clone": a repo on main with one commit.
func newCheckout(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "init", "--quiet", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "add", ".")
	run(t, dir, "commit", "--quiet", "-m", "first")
	return dir
}

func TestCreateFromCheckoutLeavesTheCheckoutAlone(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())

	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-local", Branch: "runtime/abc", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if worktree != s.worktreePath("ws-local") {
		t.Errorf("worktree = %q, want %q", worktree, s.worktreePath("ws-local"))
	}
	if got := run(t, worktree, "rev-parse", "--abbrev-ref", "HEAD"); got != "runtime/abc" {
		t.Errorf("worktree branch = %q, want runtime/abc", got)
	}
	if _, err := os.Stat(filepath.Join(worktree, "README.md")); err != nil {
		t.Errorf("worktree is missing the base commit's files: %v", err)
	}
	// The user's own checkout stays on its branch, untouched.
	if got := run(t, repo, "rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Errorf("checkout moved to %q", got)
	}
	if got := run(t, repo, "status", "--porcelain"); got != "" {
		t.Errorf("checkout is dirty after Create: %q", got)
	}
	if !s.local("ws-local") {
		t.Error("workspace not recorded as local")
	}
}

func TestCreateFromCheckoutForksFromTheRemoteBase(t *testing.T) {
	isolateGit(t)
	// origin has moved on since the user last pulled: the session must start
	// from origin/main, not the stale local main.
	upstream := newCheckout(t)
	repo := filepath.Join(t.TempDir(), "clone")
	run(t, upstream, "clone", "--quiet", upstream, repo)
	if err := os.WriteFile(filepath.Join(upstream, "NEW.md"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, upstream, "add", ".")
	run(t, upstream, "commit", "--quiet", "-m", "second")
	want := run(t, upstream, "rev-parse", "HEAD")

	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-fresh", Branch: "runtime/fresh", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := run(t, worktree, "rev-parse", "HEAD"); got != want {
		t.Errorf("worktree forked from %s, want origin/main %s", got, want)
	}
}

func TestCreateFromCheckoutForksFromTheCurrentBranchWhenNoBaseIsNamed(t *testing.T) {
	isolateGit(t)
	// A folder picked on the Mac names no base: fork from where the user is.
	repo := newCheckout(t)
	run(t, repo, "checkout", "--quiet", "-b", "feature")
	if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("f\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, repo, "add", ".")
	run(t, repo, "commit", "--quiet", "-m", "feature work")
	want := run(t, repo, "rev-parse", "HEAD")

	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-here", Branch: "runtime/here", RepoPath: filepath.Join(repo, "."), Title: "Tidy up",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := run(t, worktree, "rev-parse", "HEAD"); got != want {
		t.Errorf("worktree forked from %s, want the feature tip %s", got, want)
	}
	f, _ := s.getFacts("ws-here")
	if f.BaseBranch != "feature" || f.Name != "app" || f.Title != "Tidy up" || f.InPlace || f.CreatedAt == "" {
		t.Errorf("facts = %+v", f)
	}
}

func TestCreateInAFolderThatIsNotARepositoryWorksInPlace(t *testing.T) {
	isolateGit(t)
	folder := filepath.Join(t.TempDir(), "notes")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "todo.md"), []byte("- x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-notes", Branch: "runtime/notes", RepoPath: folder,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if worktree != folder {
		t.Errorf("worktree = %q, want the folder itself %q", worktree, folder)
	}
	if files, err := s.Changes(context.Background(), "ws-notes"); err != nil || len(files) != 0 {
		t.Errorf("Changes = %v, %v; want an empty change set", files, err)
	}

	// Destroying the session must leave the user's folder exactly as it was.
	if err := NewService(s.Root).Destroy(context.Background(), "ws-notes"); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(folder, "todo.md")); err != nil || string(data) != "- x\n" {
		t.Fatalf("destroy touched the user's folder: %q, %v", data, err)
	}
	if _, ok := NewService(s.Root).getFacts("ws-notes"); ok {
		t.Error("destroyed session is still recorded")
	}
}

func TestCreateInARepositoryWithNoCommitWorksInPlace(t *testing.T) {
	isolateGit(t)
	folder := filepath.Join(t.TempDir(), "fresh")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, folder, "init", "--quiet", "-b", "main")
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-fresh-repo", Branch: "runtime/x", RepoPath: folder,
	})
	if err != nil || worktree != folder {
		t.Fatalf("Create = %q, %v; want the folder in place", worktree, err)
	}
}

func TestCreateRejectsWhatIsNotAFolder(t *testing.T) {
	isolateGit(t)
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewService(t.TempDir())
	for _, path := range []string{"relative/path", file, filepath.Join(t.TempDir(), "missing")} {
		if _, err := s.Create(context.Background(), CreateInput{
			WorkspaceID: "ws-bad", Branch: "runtime/x", RepoPath: path,
		}); err == nil {
			t.Errorf("Create accepted %q", path)
		}
	}
}

func TestLocalSessionsListsWhatThisMacRuns(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	root := t.TempDir()
	s := NewService(root)
	for i, id := range []string{"ws-old", "ws-new"} {
		if _, err := s.Create(context.Background(), CreateInput{
			WorkspaceID: id, Branch: "runtime/" + id, RepoPath: repo, Title: id,
		}); err != nil {
			t.Fatal(err)
		}
		// Distinct creation times, oldest first.
		f, _ := s.getFacts(id)
		f.CreatedAt = []string{"2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"}[i]
		s.setFacts(id, f)
	}
	// A Runtime Computer workspace (no folder) is not a local session.
	s.setFacts("ws-cloud", workspaceFacts{Branch: "b", BaseBranch: "main"})
	// One recorded before sessions were named still gets its folder's name.
	s.setFacts("ws-unnamed", workspaceFacts{Branch: "b", RepoPath: "/Users/ada/no -video "})

	got := NewService(root).LocalSessions(context.Background())
	if len(got) != 3 || got[0].WorkspaceID != "ws-new" || got[1].WorkspaceID != "ws-old" {
		t.Fatalf("LocalSessions = %+v", got)
	}
	if got[2].WorkspaceID != "ws-unnamed" || got[2].Name != "no -video " {
		t.Errorf("unnamed session = %+v", got[2])
	}
	// git reports the repository's real path (/var is /private/var on macOS).
	realRepo, _ := filepath.EvalSymlinks(repo)
	if got[0].Name != "app" || got[0].Folder != realRepo || got[0].Worktree != s.worktreePath("ws-new") || got[0].Running {
		t.Errorf("session = %+v", got[0])
	}
}

func TestLocalSessionsReportWhenEachWasLastUsed(t *testing.T) {
	isolateGit(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	for _, id := range []string{"ws-used", "ws-untouched"} {
		if _, err := s.Create(context.Background(), CreateInput{
			WorkspaceID: id, Branch: "runtime/" + id, RepoPath: repo, Title: id,
		}); err != nil {
			t.Fatal(err)
		}
		f, _ := s.getFacts(id)
		f.CreatedAt = "2026-09-01T00:00:00Z"
		s.setFacts(id, f)
	}
	// Claude wrote to one session's transcript later than it was made.
	f, _ := s.getFacts("ws-used")
	name := "transcript.jsonl"
	if f.ClaudeSessionID != "" {
		name = f.ClaudeSessionID + ".jsonl"
	}
	dir := claudeProjectDir(home, s.worktreePath("ws-used"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(dir, name)
	if err := os.WriteFile(log, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	used := time.Date(2026, 10, 7, 9, 30, 0, 0, time.UTC)
	if err := os.Chtimes(log, used, used); err != nil {
		t.Fatal(err)
	}

	got := map[string]string{}
	for _, session := range s.LocalSessions(context.Background()) {
		got[session.WorkspaceID] = session.LastActiveAt
	}
	if got["ws-used"] != "2026-10-07T09:30:00Z" {
		t.Errorf("used session lastActiveAt = %q, want the transcript's time", got["ws-used"])
	}
	if got["ws-untouched"] != "2026-09-01T00:00:00Z" {
		t.Errorf("untouched session lastActiveAt = %q, want its creation time", got["ws-untouched"])
	}
}

func TestDestroyRemovesTheWorktreeButKeepsTheBranch(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	worktree, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-gone", Branch: "runtime/gone", BaseBranch: "main", RepoPath: repo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Work committed in the session that was never pushed.
	if err := os.WriteFile(filepath.Join(worktree, "work.txt"), []byte("w\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, worktree, "add", ".")
	run(t, worktree, "commit", "--quiet", "-m", "work")

	// A fresh Service, as after an agent restart: Destroy has to find the
	// owning repository from the worktree itself.
	if err := NewService(s.Root).Destroy(context.Background(), "ws-gone"); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Errorf("worktree still on disk: %v", err)
	}
	if list := run(t, repo, "worktree", "list"); strings.Contains(list, worktree) {
		t.Errorf("checkout still lists the worktree:\n%s", list)
	}
	if got := run(t, repo, "log", "-1", "--format=%s", "runtime/gone"); got != "work" {
		t.Errorf("session branch lost its commit, got %q", got)
	}
}

func TestConcurrentCreatesOfOneWorkspaceAllSucceed(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	s := NewService(t.TempDir())
	// Two tabs attaching at once, or a double-submitted create: the second
	// call must find the first's worktree, not race it to `worktree add`.
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			_, err := s.Create(context.Background(), CreateInput{
				WorkspaceID: "ws-twice", Branch: "runtime/twice", RepoPath: repo,
			})
			errs <- err
		}()
	}
	for range 4 {
		if err := <-errs; err != nil {
			t.Errorf("concurrent Create: %v", err)
		}
	}
}

func TestSessionsSharingAFolderKeepTheirOwnConversations(t *testing.T) {
	isolateGit(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	folder := filepath.Join(t.TempDir(), "notes")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTurns := func(path string, turns int) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(strings.Repeat(`{"type":"user"}`+"\n", turns)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The user has run Claude Code in this folder themselves.
	projectDir := claudeProjectDir(home, folder)
	writeTurns(filepath.Join(projectDir, "users-own.jsonl"), 3)

	s := NewService(t.TempDir())
	for _, id := range []string{"ws-a", "ws-b"} {
		if _, err := s.Create(context.Background(), CreateInput{WorkspaceID: id, Branch: "runtime/" + id, RepoPath: folder}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	a, _ := s.getFacts("ws-a")
	b, _ := s.getFacts("ws-b")
	if len(a.ClaudeSessionID) != 36 || a.ClaudeSessionID == b.ClaudeSessionID {
		t.Fatalf("session ids = %q, %q; want two distinct UUIDs", a.ClaudeSessionID, b.ClaudeSessionID)
	}
	// Neither session has said anything: the user's conversation is not theirs.
	if got := s.SessionLog("ws-a"); got != "" {
		t.Errorf("SessionLog before Claude wrote = %q, want none", got)
	}
	if got := s.launchCommand("ws-a", folder, true); !slices.Contains(got, "--session-id") || !slices.Contains(got, a.ClaudeSessionID) {
		t.Errorf("first launch = %v, want a new conversation under its id", got)
	}

	writeTurns(filepath.Join(projectDir, a.ClaudeSessionID+".jsonl"), 1)
	if got := s.SessionLog("ws-a"); filepath.Base(got) != a.ClaudeSessionID+".jsonl" {
		t.Errorf("SessionLog(a) = %q, want its own transcript", got)
	}
	if got := s.SessionLog("ws-b"); got != "" {
		t.Errorf("SessionLog(b) = %q, want none: a's transcript is not b's", got)
	}
	if got := s.launchCommand("ws-a", folder, false); !slices.Contains(got, "--resume") || !slices.Contains(got, a.ClaudeSessionID) {
		t.Errorf("relaunch = %v, want its own conversation resumed", got)
	}
	if a, b := s.userTurns("ws-a"), s.userTurns("ws-b"); a != 1 || b != 0 {
		t.Errorf("user turns = %d, %d; want 1, 0 (the user's own 3 counted for neither)", a, b)
	}

	// Re-creating after a restart keeps the conversation.
	if _, err := NewService(s.Root).Create(context.Background(), CreateInput{WorkspaceID: "ws-a", Branch: "runtime/ws-a", RepoPath: folder}); err != nil {
		t.Fatal(err)
	}
	if again, _ := NewService(s.Root).getFacts("ws-a"); again.ClaudeSessionID != a.ClaudeSessionID {
		t.Errorf("re-Create changed the session id: %q, want %q", again.ClaudeSessionID, a.ClaudeSessionID)
	}

	// A session recorded before ids existed keeps finding its conversation the
	// old way after a re-Create: a fresh id would cut it off from its history.
	s.setFacts("ws-old", workspaceFacts{Branch: "runtime/ws-old", RepoPath: folder, InPlace: true})
	if _, err := NewService(s.Root).Create(context.Background(), CreateInput{WorkspaceID: "ws-old", Branch: "runtime/ws-old", RepoPath: folder}); err != nil {
		t.Fatal(err)
	}
	if old, _ := NewService(s.Root).getFacts("ws-old"); old.ClaudeSessionID != "" {
		t.Errorf("re-Create gave a pre-id session the id %q; want none", old.ClaudeSessionID)
	}
}

func TestAFailedCreateLeavesNoSessionBehind(t *testing.T) {
	isolateGit(t)
	repo := newCheckout(t)
	// The session's branch is already taken, so `git worktree add -b` fails.
	run(t, repo, "branch", "runtime/taken")
	s := NewService(t.TempDir())
	if _, err := s.Create(context.Background(), CreateInput{
		WorkspaceID: "ws-taken", Branch: "runtime/taken", RepoPath: repo,
	}); err == nil {
		t.Fatal("Create succeeded with a taken branch")
	}
	if got := NewService(s.Root).LocalSessions(context.Background()); len(got) != 0 {
		t.Errorf("a failed create is still listed: %+v", got)
	}
}

package workspace

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/claude"
	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/sessiontools"
)

// controlPlane fakes the control plane's rename_branch: check answers
// `checked` (or refuses with checkStatus), commit answers commitStatus.
type controlPlane struct {
	checked      string
	checkStatus  int
	commitStatus int
	// commitDrops is how many commits are dropped unanswered (the connection
	// cut) before one is answered.
	commitDrops int
	calls       []map[string]string
}

func (c *controlPlane) serve(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var call sessiontools.Call
		if err := json.NewDecoder(r.Body).Decode(&call); err != nil || call.Tool != RenameBranchTool {
			t.Errorf("call %+v: %v", call, err)
		}
		var args map[string]string
		_ = json.Unmarshal(call.Args, &args)
		c.calls = append(c.calls, args)
		switch args["phase"] {
		case "check":
			if c.checkStatus != 0 {
				w.WriteHeader(c.checkStatus)
				_ = json.NewEncoder(w).Encode(sessiontools.Answer{Error: "refused at check"})
				return
			}
			_ = json.NewEncoder(w).Encode(sessiontools.Answer{Text: c.checked})
		case "commit":
			if c.commitDrops > 0 {
				c.commitDrops--
				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
					_ = conn.Close()
				}
				return
			}
			if c.commitStatus != 0 {
				w.WriteHeader(c.commitStatus)
				_ = json.NewEncoder(w).Encode(sessiontools.Answer{Error: "refused at commit"})
				return
			}
			_ = json.NewEncoder(w).Encode(sessiontools.Answer{Text: args["to"]})
		}
	}))
}

// renameSession makes a cloud session `ws` on branch, renamable, in a box
// whose sessions reach cp: one repository, or a folder of the named ones.
func renameSession(t *testing.T, cp *controlPlane, branch string, checkouts ...string) (*Service, []string) {
	t.Helper()
	isolateGit(t)
	s := NewService(t.TempDir())
	server := cp.serve(t)
	t.Cleanup(server.Close)
	s.RelayExecutable = "/opt/runtime-agent"
	if err := s.UseGitCredential(&gitcred.Client{Config: gitcred.Config{AppURL: server.URL, SandboxID: "box", Secret: "secret"}, HTTP: server.Client()}); err != nil {
		t.Fatal(err)
	}
	worktree := s.worktreePath("ws")
	dirs := []string{worktree}
	f := workspaceFacts{Branch: branch, BranchRenamable: true, BaseBranch: "main"}
	if len(checkouts) > 0 {
		dirs = nil
		for _, name := range checkouts {
			dirs = append(dirs, filepath.Join(worktree, name))
			f.Checkouts = append(f.Checkouts, Checkout{Name: name, FullName: "acme/" + name, BaseBranch: "main"})
		}
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		run(t, dir, "init", "-q", "-b", branch)
		run(t, dir, "commit", "-q", "--allow-empty", "-m", "first")
	}
	s.setFacts("ws", f)
	return s, dirs
}

func renameTo(t *testing.T, s *Service, key, name string) (int, sessiontools.Answer) {
	t.Helper()
	args, _ := json.Marshal(map[string]string{"name": name})
	status, answer, err := s.SessionTool(context.Background(), sessiontools.Call{Workspace: key, Tool: RenameBranchTool, Args: args})
	if err != nil {
		t.Fatalf("SessionTool: %v", err)
	}
	return status, answer
}

func head(t *testing.T, dir string) string {
	t.Helper()
	return run(t, dir, "symbolic-ref", "--short", "HEAD")
}

func TestRenamingTheBranchRenamesItAndRecordsIt(t *testing.T) {
	cp := &controlPlane{checked: "fix/google-sign-in"}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")

	status, answer := renameTo(t, s, "ws", "fix/google-sign-in")
	if status != http.StatusOK || !strings.Contains(answer.Text, "fix/google-sign-in") {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	if got := head(t, dirs[0]); got != "fix/google-sign-in" {
		t.Errorf("branch = %q", got)
	}
	f, _ := s.getFacts("ws")
	if f.Branch != "fix/google-sign-in" || f.BranchRenamable {
		t.Errorf("facts = %+v", f)
	}
	if len(cp.calls) != 2 || cp.calls[1]["from"] != "sign-fails-google-users" || cp.calls[1]["to"] != "fix/google-sign-in" {
		t.Errorf("control plane calls = %+v", cp.calls)
	}
	// Once only.
	if status, _ := renameTo(t, s, "ws", "fix/other"); status != http.StatusConflict {
		t.Errorf("second rename: %d", status)
	}
}

func TestATakenNameIsRenamedToTheNumberedOneAndSaysSo(t *testing.T) {
	cp := &controlPlane{checked: "fix/google-sign-in-2"}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	status, answer := renameTo(t, s, "ws", "fix/google-sign-in")
	if status != http.StatusOK || !strings.Contains(answer.Text, "was taken") {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	if got := head(t, dirs[0]); got != "fix/google-sign-in-2" {
		t.Errorf("branch = %q", got)
	}
}

func TestEveryCheckoutOfASessionOfSeveralIsRenamed(t *testing.T) {
	cp := &controlPlane{checked: "feat/shared-login"}
	s, dirs := renameSession(t, cp, "shared-login", "api", "web")
	if status, answer := renameTo(t, s, "ws", "feat/shared-login"); status != http.StatusOK {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	for _, dir := range dirs {
		if got := head(t, dir); got != "feat/shared-login" {
			t.Errorf("%s: branch = %q", filepath.Base(dir), got)
		}
	}
}

func TestARefusedCommitPutsTheBranchBackEverywhere(t *testing.T) {
	cp := &controlPlane{checked: "feat/shared-login", commitStatus: http.StatusConflict}
	s, dirs := renameSession(t, cp, "shared-login", "api", "web")
	status, answer := renameTo(t, s, "ws", "feat/shared-login")
	if status != http.StatusConflict || answer.Error != "refused at commit" {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	for _, dir := range dirs {
		if got := head(t, dir); got != "shared-login" {
			t.Errorf("%s: branch = %q, want it put back", filepath.Base(dir), got)
		}
	}
	if f, _ := s.getFacts("ws"); f.Branch != "shared-login" || !f.BranchRenamable {
		t.Errorf("facts = %+v", f)
	}
}

func TestAGitFailurePartWayPutsBackTheCheckoutsDone(t *testing.T) {
	cp := &controlPlane{checked: "feat/shared-login"}
	s, dirs := renameSession(t, cp, "shared-login", "api", "web")
	// The second checkout already has the new name: its rename fails.
	run(t, dirs[1], "branch", "feat/shared-login")
	if status, _ := renameTo(t, s, "ws", "feat/shared-login"); status != http.StatusConflict {
		t.Fatalf("rename: %d", status)
	}
	if got := head(t, dirs[0]); got != "shared-login" {
		t.Errorf("api: branch = %q, want it put back", got)
	}
	if len(cp.calls) != 1 {
		t.Errorf("committed despite git failing: %+v", cp.calls)
	}
}

func TestARefusedCheckRenamesNothing(t *testing.T) {
	cp := &controlPlane{checkStatus: http.StatusConflict}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	status, answer := renameTo(t, s, "ws", "fix/google-sign-in")
	if status != http.StatusConflict || answer.Error != "refused at check" {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	if got := head(t, dirs[0]); got != "sign-fails-google-users" {
		t.Errorf("branch = %q", got)
	}
}

func TestOnlyAMadeUpBranchStillCheckedOutIsRenamed(t *testing.T) {
	cp := &controlPlane{checked: "fix/x"}
	s, dirs := renameSession(t, cp, "some-words")
	// Switched to another branch: refused, before Outrunner is asked.
	run(t, dirs[0], "switch", "-q", "-c", "other")
	if status, _ := renameTo(t, s, "ws", "fix/x"); status != http.StatusConflict {
		t.Errorf("rename off the branch: %d", status)
	}
	run(t, dirs[0], "switch", "-q", "some-words")
	// A branch the user chose.
	s.updateFacts("ws", func(f *workspaceFacts) { f.BranchRenamable = false })
	if status, _ := renameTo(t, s, "ws", "fix/x"); status != http.StatusConflict {
		t.Errorf("rename of a chosen branch: %d", status)
	}
	if len(cp.calls) != 0 {
		t.Errorf("Outrunner was asked: %+v", cp.calls)
	}
}

func TestTheAgentIsToldToNameItsBranchUntilItHas(t *testing.T) {
	cp := &controlPlane{checked: "fix/google-sign-in"}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	o := s.orientation("ws", dirs[0])
	for _, want := range []string{"# Branch name", "`sign-fails-google-users`", "outrunner-session rename-branch <type>/<what-it-does>", "or to give it its real name once"} {
		if !strings.Contains(o, want) {
			t.Errorf("orientation lacks %q:\n%s", want, o)
		}
	}
	renameTo(t, s, "ws", "fix/google-sign-in")
	o = s.orientation("ws", dirs[0])
	if strings.Contains(o, "# Branch name") || strings.Contains(o, "real name once") {
		t.Errorf("still told to name it after it was named:\n%s", o)
	}
	if !strings.Contains(o, "Do not rename the current branch unless the user explicitly tells you to do so.\n") {
		t.Errorf("the no-rename rule is gone:\n%s", o)
	}
}

func TestBranchToNameOrientationKeepsTheRuleWithItsException(t *testing.T) {
	o := claude.Orientation("/work/ws1", "main", claude.BranchToName)
	if !strings.Contains(o, "temporary name Outrunner made from the first message") ||
		!strings.Contains(o, "unless the user explicitly tells you to do so, or to give it its real name once") {
		t.Errorf("orientation:\n%s", o)
	}
}

// push runs the sessions' git (the guard) in dir: its output and whether it
// pushed.
func push(t *testing.T, s *Service, dir string, args ...string) (string, bool) {
	t.Helper()
	cmd := exec.Command(filepath.Join(s.gitBinDir(), "git"), append([]string{"push", "-q"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err == nil
}

func TestAPushOfAStandInBranchIsRefusedOnceUntilItsNamed(t *testing.T) {
	cp := &controlPlane{checked: "fix/google-sign-in"}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	s.markStandIns(dirs, "sign-fails-google-users", true)
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, dirs[0], "init", "-q", "--bare", remote)
	run(t, dirs[0], "remote", "add", "origin", remote)

	out, ok := push(t, s, dirs[0], "-u", "origin", "HEAD")
	if ok || !strings.Contains(out, "outrunner-session rename-branch") {
		t.Fatalf("push on the stand-in: ok=%v\n%s", ok, out)
	}
	if status, answer := renameTo(t, s, "ws", "fix/google-sign-in"); status != http.StatusOK {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	if out, ok := push(t, s, dirs[0], "-u", "origin", "HEAD"); !ok {
		t.Fatalf("push after the rename: %s", out)
	}
	if got := run(t, remote, "branch", "--list"); !strings.Contains(got, "fix/google-sign-in") || strings.Contains(got, "sign-fails-google-users") {
		t.Errorf("origin has %q", got)
	}
}

func TestASecondPushOfAStandInGoesThrough(t *testing.T) {
	s, dirs := renameSession(t, &controlPlane{}, "some-words")
	s.markStandIns(dirs, "some-words", true)
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, dirs[0], "init", "-q", "--bare", remote)
	if _, ok := push(t, s, dirs[0], remote, "HEAD"); ok {
		t.Fatal("the first push went through")
	}
	// -C and -c before the command are still read as a push of this branch.
	cmd := exec.Command(filepath.Join(s.gitBinDir(), "git"), "-C", dirs[0], "-c", "push.default=current", "push", "-q", remote, "HEAD")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("the second push was refused: %s", out)
	}
	// Anything but a push is passed through untouched.
	if got := strings.TrimSpace(func() string {
		out, _ := exec.Command(filepath.Join(s.gitBinDir(), "git"), "-C", dirs[0], "symbolic-ref", "--short", "HEAD").Output()
		return string(out)
	}()); got != "some-words" {
		t.Errorf("symbolic-ref through the wrapper = %q", got)
	}
}

// Two sessions in one box on the same stand-in name (every prompt with no
// Latin letters gets "session"): each worktree has its own guard.
func TestTwoSessionsOnOneStandInNameAreGuardedApart(t *testing.T) {
	cp := &controlPlane{checked: "fix/login-page"}
	s, dirs := renameSession(t, cp, "session")
	other := s.worktreePath("ws2")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, other, "init", "-q", "-b", "session")
	run(t, other, "commit", "-q", "--allow-empty", "-m", "first")
	s.setFacts("ws2", workspaceFacts{Branch: "session", BranchRenamable: true, BaseBranch: "main"})
	// Each launch marks its own worktree.
	s.orientation("ws", dirs[0])
	s.orientation("ws2", other)

	if status, answer := renameTo(t, s, "ws", "fix/login-page"); status != http.StatusOK {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, other, "init", "-q", "--bare", remote)
	// The renamed one pushes; the other is still on its stand-in, and guarded.
	if out, ok := push(t, s, dirs[0], remote, "HEAD"); !ok {
		t.Fatalf("the renamed session's push: %s", out)
	}
	if out, ok := push(t, s, other, remote, "HEAD"); ok || !strings.Contains(out, "rename-branch") {
		t.Fatalf("the other session's push wasn't refused: ok=%v %s", ok, out)
	}
}

func TestAWorktreeOnAnotherBranchIsntGuarded(t *testing.T) {
	s, dirs := renameSession(t, &controlPlane{}, "some-words")
	s.markStandIns(dirs, "some-words", true)
	run(t, dirs[0], "switch", "-q", "-c", "fix/elsewhere")
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, dirs[0], "init", "-q", "--bare", remote)
	if out, ok := push(t, s, dirs[0], remote, "HEAD"); !ok {
		t.Fatalf("a push from another branch was refused: %s", out)
	}
}

func TestACommitWithNoAnswerIsSentAgain(t *testing.T) {
	commitBackoff = time.Millisecond
	cp := &controlPlane{checked: "fix/google-sign-in", commitDrops: 1}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	if status, answer := renameTo(t, s, "ws", "fix/google-sign-in"); status != http.StatusOK {
		t.Fatalf("rename: %d %+v", status, answer)
	}
	if got := head(t, dirs[0]); got != "fix/google-sign-in" {
		t.Errorf("branch = %q", got)
	}
}

// Outrunner may have recorded a commit whose answer never came: git keeps
// the new name rather than disagree, and the same command finishes it.
func TestARenameNeverAnsweredKeepsGitOnTheNewNameUntilRunAgain(t *testing.T) {
	commitBackoff = time.Millisecond
	cp := &controlPlane{checked: "fix/google-sign-in", commitDrops: commitAttempts}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	status, answer := renameTo(t, s, "ws", "fix/google-sign-in")
	if status/100 == 2 || !strings.Contains(answer.Error, "rename-branch fix/google-sign-in") {
		t.Fatalf("rename with no answer: %d %+v", status, answer)
	}
	if got := head(t, dirs[0]); got != "fix/google-sign-in" {
		t.Errorf("branch = %q, want it left on the new name", got)
	}
	if f, _ := s.getFacts("ws"); f.Branch != "sign-fails-google-users" || !f.BranchRenamable {
		t.Errorf("facts = %+v before it's confirmed", f)
	}
	// The unconfirmed name is guarded, saying to finish it with the same name.
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, dirs[0], "init", "-q", "--bare", remote)
	if out, ok := push(t, s, dirs[0], remote, "HEAD"); ok || !strings.Contains(out, "isn't confirmed yet") || !strings.Contains(out, "rename-branch fix/google-sign-in") {
		t.Fatalf("a push of the unconfirmed name wasn't refused as one: ok=%v %s", ok, out)
	}
	// The next launch says so too.
	if o := s.orientation("ws", dirs[0]); !strings.Contains(o, "hasn't confirmed it yet") || !strings.Contains(o, "rename-branch fix/google-sign-in") {
		t.Errorf("orientation doesn't say to finish the rename:\n%s", o)
	}
	// Run again, even with another name: no new check, no git rename, just
	// the commit of the name git has.
	calls := len(cp.calls)
	status, answer = renameTo(t, s, "ws", "fix/another-name")
	if status != http.StatusOK || !strings.Contains(answer.Text, "Finished the rename") {
		t.Fatalf("run again: %d %+v", status, answer)
	}
	if got := cp.calls[calls:]; len(got) != 1 || got[0]["phase"] != "commit" || got[0]["from"] != "sign-fails-google-users" {
		t.Errorf("calls on the second run = %+v", got)
	}
	if f, _ := s.getFacts("ws"); f.Branch != "fix/google-sign-in" || f.BranchRenamable || f.PendingBranch != "" {
		t.Errorf("facts = %+v", f)
	}
	if o := s.orientation("ws", dirs[0]); strings.Contains(o, "# Branch name") {
		t.Errorf("still told about the branch once it's named:\n%s", o)
	}
}

// Pushed already, or with a pull request: refused for good, so the agent
// isn't told to rename it again, and its pushes aren't guarded.
func TestARefusalForGoodStopsOfferingTheRename(t *testing.T) {
	cp := &controlPlane{checkStatus: http.StatusGone}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	if o := s.orientation("ws", dirs[0]); !strings.Contains(o, "# Branch name") {
		t.Fatal("not offered to begin with")
	}
	if status, _ := renameTo(t, s, "ws", "fix/google-sign-in"); status != http.StatusGone {
		t.Fatalf("rename: %d", status)
	}
	if f, _ := s.getFacts("ws"); f.BranchRenamable || f.Branch != "sign-fails-google-users" {
		t.Errorf("facts = %+v", f)
	}
	if o := s.orientation("ws", dirs[0]); strings.Contains(o, "# Branch name") {
		t.Errorf("still offered after a refusal for good:\n%s", o)
	}
	gitDir := run(t, dirs[0], "rev-parse", "--absolute-git-dir")
	if _, err := os.Stat(filepath.Join(gitDir, standInFile)); !os.IsNotExist(err) {
		t.Errorf("the push guard's marker is still there: %v", err)
	}
}

func TestACommitRefusedPutsTheStandInsGuardBack(t *testing.T) {
	cp := &controlPlane{checked: "fix/google-sign-in", commitStatus: http.StatusConflict}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	s.markStandIns(dirs, "sign-fails-google-users", true)
	if status, _ := renameTo(t, s, "ws", "fix/google-sign-in"); status != http.StatusConflict {
		t.Fatalf("rename: %d", status)
	}
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, dirs[0], "init", "-q", "--bare", remote)
	if _, ok := push(t, s, dirs[0], remote, "HEAD"); ok {
		t.Fatal("the stand-in, back after a refusal, wasn't guarded")
	}
}

// A worktree made since a rename went unconfirmed (a restore, on git's name)
// gets the unconfirmed guard back at its next launch.
func TestAnUnconfirmedRenameIsGuardedAgainAtEachLaunch(t *testing.T) {
	commitBackoff = time.Millisecond
	cp := &controlPlane{checked: "fix/google-sign-in", commitDrops: commitAttempts}
	s, dirs := renameSession(t, cp, "sign-fails-google-users")
	renameTo(t, s, "ws", "fix/google-sign-in")
	gitDir := run(t, dirs[0], "rev-parse", "--absolute-git-dir")
	for _, f := range []string{standInFile, standInFile + ".unconfirmed", standInFile + ".refused"} {
		_ = os.Remove(filepath.Join(gitDir, f))
	}
	s.orientation("ws", dirs[0])
	remote := filepath.Join(t.TempDir(), "origin.git")
	run(t, dirs[0], "init", "-q", "--bare", remote)
	if out, ok := push(t, s, dirs[0], remote, "HEAD"); ok || !strings.Contains(out, "isn't confirmed yet") {
		t.Fatalf("not guarded after the launch: ok=%v %s", ok, out)
	}
}

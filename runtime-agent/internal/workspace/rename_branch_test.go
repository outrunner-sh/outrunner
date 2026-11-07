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
	calls        []map[string]string
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
	s.markStandIn("sign-fails-google-users", true)
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
	s.markStandIn("some-words", true)
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

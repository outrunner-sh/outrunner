package workspace

import (
	"context"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

const (
	testBoxGitHubToken     = "gho_box-user-0123456789abcdef"
	testSessionGitHubToken = "ghs_session-app-0123456789abcdef"
)

// sessionWithOwnGitHubToken is a session created with a token of its own.
func sessionWithOwnGitHubToken(t *testing.T) (*Service, *fakeSessions, string) {
	t.Helper()
	s, fake, id := runningSession(t, "sonnet")
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), GitHubToken: testSessionGitHubToken}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return s, fake, id
}

// launchedGitHubToken runs a launch's wrappers (everything up to the agent
// itself) with the box's GH_TOKEN in the environment, as a running tmux
// server would give the pane, and answers the GH_TOKEN and git helper the
// agent would get.
func launchedGitHubToken(t *testing.T, argv []string) (token, helper string) {
	t.Helper()
	i := slices.IndexFunc(argv, func(arg string) bool { return arg == "claude" || strings.HasSuffix(arg, "/claude") })
	if i < 0 {
		t.Fatalf("no claude in the launch %q", argv)
	}
	probe := append(append([]string(nil), argv[:i]...), "sh", "-c", `printf '%s\n%s\n%s\n%s' "$GH_TOKEN" "$GIT_CONFIG_VALUE_1" "$GITHUB_TOKEN" "$GH_CONFIG_DIR"`)
	cmd := exec.Command(probe[0], probe[1:]...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), githubTokenEnv + "=" + testBoxGitHubToken, "GITHUB_TOKEN=" + testBoxGitHubToken}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run the launch's wrappers: %v", err)
	}
	lines := strings.Split(string(out), "\n")
	token, helper = lines[0], lines[1]
	// Any session on its own token, or on none, is kept off the user's other
	// GitHub credentials.
	if s := strings.Join(argv, " "); strings.Contains(s, "/github/") && (lines[2] != "" || lines[3] == "") {
		t.Errorf("GITHUB_TOKEN %q and GH_CONFIG_DIR %q: the user's other credentials are reachable", lines[2], lines[3])
	}
	return token, helper
}

func TestASessionWithItsOwnGitHubTokenLaunchesOnItWhateverTmuxGivesThePane(t *testing.T) {
	t.Parallel()
	s, _, id := sessionWithOwnGitHubToken(t)
	token, helper := launchedGitHubToken(t, s.launchCommand(id, s.worktreePath(id), false))
	if token != testSessionGitHubToken {
		t.Errorf("launches with GH_TOKEN %q, want the session's own", token)
	}
	if !strings.Contains(helper, "$GH_TOKEN") {
		t.Errorf("git isn't pointed at the session's token: helper %q", helper)
	}
	if strings.Contains(strings.Join(s.launchCommand(id, s.worktreePath(id), false), " "), testSessionGitHubToken) {
		t.Error("the token is on the command line, where ps shows it")
	}
}

func TestASessionWithoutItsOwnTokenLaunchesAsBefore(t *testing.T) {
	t.Parallel()
	s, _, id := runningSession(t, "sonnet")
	if token, _ := launchedGitHubToken(t, s.launchCommand(id, s.worktreePath(id), false)); token != testBoxGitHubToken {
		t.Errorf("launches with GH_TOKEN %q, want the box's", token)
	}
}

func TestARepeatedCreateKeepsTheSessionsOwnToken(t *testing.T) {
	t.Parallel()
	s, _, id := sessionWithOwnGitHubToken(t)
	// Even with its facts lost, the file says it has one.
	s.mu.Lock()
	delete(s.facts, id)
	s.mu.Unlock()
	_ = os.Remove(s.factsPath(id))
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir()}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create again: %v", err)
	}
	if token, _ := launchedGitHubToken(t, s.launchCommand(id, s.worktreePath(id), false)); token != testSessionGitHubToken {
		t.Errorf("after a repeated Create, GH_TOKEN %q, want the session's own", token)
	}
	if !slices.Contains(s.RedactionSecrets(), testSessionGitHubToken) {
		t.Error("the session's token is not masked")
	}
	if !slices.Contains(NewService(s.Root).RedactionSecrets(), testSessionGitHubToken) {
		t.Error("after a restart the session's token is not masked")
	}
}

func TestASessionThatLostItsGitHubTokenNeverFallsBackToTheBoxs(t *testing.T) {
	t.Parallel()
	s, _, id := sessionWithOwnGitHubToken(t)
	if err := os.Remove(s.githubFiles().path(id)); err != nil {
		t.Fatal(err)
	}
	if token, _ := launchedGitHubToken(t, s.launchCommand(id, s.worktreePath(id), false)); token != "" {
		t.Errorf("launches with GH_TOKEN %q, want none", token)
	}
}

func TestForgettingASessionRemovesItsGitHubToken(t *testing.T) {
	t.Parallel()
	s, _, id := sessionWithOwnGitHubToken(t)
	s.forgetWorkspace(id)
	if _, err := os.Stat(s.githubFiles().path(id)); !os.IsNotExist(err) {
		t.Errorf("the token file is still there: %v", err)
	}
}

// gitCredentialFor asks git, through a launch's wrappers, for github.com's
// credential, in a HOME whose ~/.gitconfig stores the user's own.
func gitCredentialFor(t *testing.T, argv []string) string {
	t.Helper()
	i := slices.IndexFunc(argv, func(arg string) bool { return arg == "claude" || strings.HasSuffix(arg, "/claude") })
	if i < 0 {
		t.Fatalf("no claude in the launch %q", argv)
	}
	home := t.TempDir()
	if err := os.WriteFile(home+"/.git-credentials", []byte("https://user:"+testBoxGitHubToken+"@github.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(home+"/.gitconfig", []byte("[credential]\n\thelper = store\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	probe := append(append([]string(nil), argv[:i]...), "git", "credential", "fill")
	cmd := exec.Command(probe[0], probe[1:]...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "GIT_TERMINAL_PROMPT=0"}
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\n\n")
	out, _ := cmd.CombinedOutput()
	return string(out)
}

func TestGitNeverAnswersWithTheUsersStoredCredential(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, _, id := sessionWithOwnGitHubToken(t)
	if out := gitCredentialFor(t, s.launchCommand(id, s.worktreePath(id), false)); !strings.Contains(out, "password="+testSessionGitHubToken) {
		t.Errorf("git answers %q, want the session's token", out)
	}
	if err := os.Remove(s.githubFiles().path(id)); err != nil {
		t.Fatal(err)
	}
	if out := gitCredentialFor(t, s.launchCommand(id, s.worktreePath(id), false)); strings.Contains(out, testBoxGitHubToken) {
		t.Errorf("with its token gone, git answers with the user's: %q", out)
	}
}

func TestGitNeverPushesOverTheBoxsSSHKey(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, _, id := sessionWithOwnGitHubToken(t)
	t.Run("on its own token", func(t *testing.T) { checkNoSSH(t, s.launchCommand(id, s.worktreePath(id), false)) })
	if err := os.Remove(s.githubFiles().path(id)); err != nil {
		t.Fatal(err)
	}
	t.Run("with its token gone", func(t *testing.T) { checkNoSSH(t, s.launchCommand(id, s.worktreePath(id), false)) })
}

// checkNoSSH runs `git ls-remote` on an https remote through a launch's
// wrappers, in a HOME whose gitconfig sends it over SSH, with an SSH agent
// in the environment: git must refuse SSH, and the agent mustn't reach it.
func checkNoSSH(t *testing.T, argv []string) {
	t.Helper()
	i := slices.IndexFunc(argv, func(arg string) bool { return arg == "claude" || strings.HasSuffix(arg, "/claude") })
	if i < 0 {
		t.Fatalf("no claude in the launch %q", argv)
	}
	home := t.TempDir()
	// A common line in a user's gitconfig: https remotes go over SSH.
	if err := os.WriteFile(home+"/.gitconfig", []byte("[url \"git@github.com:\"]\n\tinsteadOf = https://github.com/\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	used := home + "/ssh-used"
	probe := append(append([]string(nil), argv[:i]...), "sh", "-c", `echo "agent=$SSH_AUTH_SOCK"; git ls-remote https://github.com/acme/web`)
	cmd := exec.Command(probe[0], probe[1:]...)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + home, "GIT_TERMINAL_PROMPT=0",
		"GIT_SSH_COMMAND=touch " + used + "; false", "SSH_AUTH_SOCK=/tmp/user-agent.sock",
	}
	out, _ := cmd.CombinedOutput()
	if _, err := os.Stat(used); err == nil {
		t.Errorf("git went over SSH, as the user: %s", out)
	}
	if !strings.Contains(string(out), "not allowed") {
		t.Errorf("git didn't refuse SSH: %s", out)
	}
	if !strings.Contains(string(out), "agent=\n") {
		t.Errorf("the user's SSH agent is reachable: %s", out)
	}
}

func TestASessionOnItsOwnTokenCommitsUnsigned(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s, _, id := sessionWithOwnGitHubToken(t)
	argv := s.launchCommand(id, s.worktreePath(id), false)
	i := slices.IndexFunc(argv, func(arg string) bool { return arg == "claude" || strings.HasSuffix(arg, "/claude") })
	if i < 0 {
		t.Fatalf("no claude in the launch %q", argv)
	}
	home, repo := t.TempDir(), t.TempDir()
	// The user signs every commit with a key their SSH agent holds.
	config := "[user]\n\tname = U\n\temail = u@example.test\n\tsigningkey = " + home + "/missing.pub\n" +
		"[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n"
	if err := os.WriteFile(home+"/.gitconfig", []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home}
	initRepo := exec.Command("git", "init", "-q", repo)
	initRepo.Env = env
	if out, err := initRepo.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	probe := append(append([]string(nil), argv[:i]...), "git", "-C", repo, "commit", "--allow-empty", "-qm", "review")
	cmd := exec.Command(probe[0], probe[1:]...)
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Errorf("commit failed (signing?): %v %s", err, out)
	}
}

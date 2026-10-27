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
	probe := append(append([]string(nil), argv[:i]...), "sh", "-c", `printf '%s\n%s' "$GH_TOKEN" "$GIT_CONFIG_VALUE_0"`)
	cmd := exec.Command(probe[0], probe[1:]...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), githubTokenEnv + "=" + testBoxGitHubToken}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run the launch's wrappers: %v", err)
	}
	token, helper, _ = strings.Cut(string(out), "\n")
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

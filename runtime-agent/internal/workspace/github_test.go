package workspace

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
)

const (
	testBoxGitHubToken     = "gho_box-user-0123456789abcdef"
	testSessionGitHubToken = "ghs_session-app-0123456789abcdef"
)

// githubTokenIn is the GH_TOKEN an environment sets, and whether it sets one.
func githubTokenIn(env []string) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		if value, ok := strings.CutPrefix(env[i], githubTokenEnv+"="); ok {
			return value, true
		}
	}
	return "", false
}

func TestASessionWithItsOwnGitHubTokenLaunchesWithIt(t *testing.T) {
	t.Parallel()
	s, _, id := runningSession(t, "sonnet")
	s.env = append(s.env, githubTokenEnv+"="+testBoxGitHubToken)
	a := s.agentFor(id)

	if got, _ := githubTokenIn(s.launchEnv(a, id, "")); got != testBoxGitHubToken {
		t.Fatalf("a session without its own token launches with %q, want the box's", got)
	}

	ctx := context.Background()
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), GitHubToken: testSessionGitHubToken}
	if _, err := s.Create(ctx, in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got, _ := githubTokenIn(s.launchEnv(a, id, "")); got != testSessionGitHubToken {
		t.Errorf("launches with GH_TOKEN %q, want the session's own", got)
	}
	env := s.launchEnv(a, id, "")
	if slices.Contains(env, githubTokenEnv+"="+testBoxGitHubToken) {
		t.Error("the box's token is still in the session's environment")
	}

	// A repeated Create (an agent restart) without a token keeps the one it has.
	in.GitHubToken = ""
	if _, err := s.Create(ctx, in); err != nil {
		t.Fatalf("Create again: %v", err)
	}
	if got, _ := githubTokenIn(s.launchEnv(a, id, "")); got != testSessionGitHubToken {
		t.Errorf("after a repeated Create, GH_TOKEN %q, want the session's own", got)
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
	s, _, id := runningSession(t, "sonnet")
	s.env = append(s.env, githubTokenEnv+"="+testBoxGitHubToken)
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), GitHubToken: testSessionGitHubToken}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := os.Remove(s.githubFiles().path(id)); err != nil {
		t.Fatal(err)
	}
	if got, set := githubTokenIn(s.launchEnv(s.agentFor(id), id, "")); set {
		t.Errorf("launches with GH_TOKEN %q, want none", got)
	}
}

func TestForgettingASessionRemovesItsGitHubToken(t *testing.T) {
	t.Parallel()
	s, _, id := runningSession(t, "sonnet")
	if err := s.setSessionGitHubToken(id, testSessionGitHubToken); err != nil {
		t.Fatal(err)
	}
	s.forgetWorkspace(id)
	if _, err := os.Stat(s.githubFiles().path(id)); !os.IsNotExist(err) {
		t.Errorf("the token file is still there: %v", err)
	}
}

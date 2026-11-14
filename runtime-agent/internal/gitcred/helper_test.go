package gitcred

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeAgent stands in for the agent's POST /git-credential, recording the
// requests it was sent.
type fakeAgent struct {
	mu       sync.Mutex
	requests []LocalRequest
	auth     []string
	fail     string
	// refused answers 409: Outrunner said no on purpose.
	refused bool
}

func (a *fakeAgent) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req LocalRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	a.mu.Lock()
	a.requests = append(a.requests, req)
	a.auth = append(a.auth, r.Header.Get("Authorization"))
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path != "/git-credential":
		w.WriteHeader(http.StatusNotFound)
	case a.fail != "" && a.refused:
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(LocalError{Error: a.fail})
	case a.fail != "":
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(LocalError{Error: a.fail})
	case req.Erase:
		w.WriteHeader(http.StatusNoContent)
	default:
		_ = json.NewEncoder(w).Encode(LocalResponse{Token: "ghs_for_" + req.Repo})
	}
}

// startAgent serves a fake agent, announced under a root as the real one
// is.
func startAgent(t *testing.T, agent *fakeAgent) Local {
	t.Helper()
	ts := httptest.NewServer(agent)
	t.Cleanup(ts.Close)
	dir := t.TempDir()
	local := Local{AddrFile: filepath.Join(dir, "agent.addr"), TokenFile: filepath.Join(dir, "git-credential.token")}
	if err := os.WriteFile(local.AddrFile, []byte(strings.TrimPrefix(ts.URL, "http://")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local.TokenFile, []byte("local-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return local
}

func runHelper(local Local, op, stdin, fallback string) (string, string, int) {
	var out, errOut bytes.Buffer
	code := Helper(context.Background(), op, strings.NewReader(stdin), &out, &errOut, local, fallback)
	return out.String(), errOut.String(), code
}

func TestHelperAnswersGitWithTheAgentsTokenForThePath(t *testing.T) {
	agent := &fakeAgent{}
	local := startAgent(t, agent)
	out, _, code := runHelper(local, "get", "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n", "")
	if code != 0 || out != "username=x-access-token\npassword=ghs_for_acme/widgets\n" {
		t.Fatalf("get = %q (%d)", out, code)
	}
	if agent.requests[0] != (LocalRequest{Repo: "acme/widgets"}) || agent.auth[0] != "Bearer local-token" {
		t.Fatalf("agent got %+v with %q", agent.requests[0], agent.auth[0])
	}

	// Without useHttpPath's path, the box's own project.
	out, _, _ = runHelper(local, "get", "protocol=https\nhost=github.com\n", "")
	if out != "username=x-access-token\npassword=ghs_for_\n" || agent.requests[1].Repo != "" {
		t.Fatalf("get without a path = %q, asked %+v", out, agent.requests[1])
	}
}

func TestHelperLeavesOtherHostsAndOperationsAlone(t *testing.T) {
	agent := &fakeAgent{}
	local := startAgent(t, agent)
	for _, c := range []struct{ op, stdin string }{
		{"get", "protocol=https\nhost=bitbucket.org\npath=acme/widgets.git\n"},
		{"get", "protocol=http\nhost=github.com\npath=acme/widgets.git\n"},
		{"store", "protocol=https\nhost=github.com\npath=acme/widgets.git\nusername=x\npassword=y\n"},
		{"", ""},
	} {
		if out, _, code := runHelper(local, c.op, c.stdin, "gho_fallback"); out != "" || code != 0 {
			t.Errorf("%s %q answered %q (%d)", c.op, c.stdin, out, code)
		}
	}
	if len(agent.requests) != 0 {
		t.Fatalf("agent asked %+v", agent.requests)
	}
}

func TestHelperEraseHasTheAgentForgetTheToken(t *testing.T) {
	agent := &fakeAgent{}
	local := startAgent(t, agent)
	out, _, code := runHelper(local, "erase", "protocol=https\nhost=github.com\npath=/acme/widgets.git\nusername=x-access-token\npassword=old\n", "")
	if out != "" || code != 0 || agent.requests[0] != (LocalRequest{Repo: "acme/widgets", Erase: true}) {
		t.Fatalf("erase = %q (%d), agent got %+v", out, code, agent.requests)
	}
}

func TestHelperFallsBackToTheLaunchToken(t *testing.T) {
	agent := &fakeAgent{fail: "The Outrunner GitHub App can't reach acme/widgets"}
	local := startAgent(t, agent)
	stdin := "protocol=https\nhost=github.com\npath=acme/widgets.git\n"
	if out, _, _ := runHelper(local, "get", stdin, "gho_fallback"); out != "username=x-access-token\npassword=gho_fallback\n" {
		t.Fatalf("with a fallback = %q", out)
	}
	out, errOut, code := runHelper(local, "get", stdin, "")
	if out != "" || code != 0 || !strings.Contains(errOut, "acme/widgets: The Outrunner GitHub App can't reach acme/widgets") {
		t.Fatalf("without a fallback = %q, %q (%d)", out, errOut, code)
	}

	// No agent at all.
	gone := Local{AddrFile: filepath.Join(t.TempDir(), "agent.addr"), TokenFile: local.TokenFile}
	if out, _, _ := runHelper(gone, "get", stdin, "gho_fallback"); !strings.Contains(out, "password=gho_fallback") {
		t.Fatalf("without an agent = %q", out)
	}
}

// A user who chose the App, refused it for a repository, isn't pushed as
// themselves with the token the box was launched with.
func TestNeitherHelperFallsBackWhenOutrunnerRefuses(t *testing.T) {
	agent := &fakeAgent{fail: "Outrunner's GitHub App isn't installed on acme for this org.", refused: true}
	local := startAgent(t, agent)
	stdin := "protocol=https\nhost=github.com\npath=acme/widgets.git\n"
	out, errOut, code := runHelper(local, "get", stdin, "gho_fallback")
	if out != "" || code != 0 || !strings.Contains(errOut, "isn't installed on acme") {
		t.Fatalf("git helper = %q, %q (%d)", out, errOut, code)
	}
	var tokenOut, tokenErr bytes.Buffer
	getenv := func(name string) string {
		if name == "GH_TOKEN" {
			return "gho_fallback"
		}
		return ""
	}
	if code := GitHubToken(context.Background(), []string{"-R", "acme/widgets"}, &tokenOut, &tokenErr, local, getenv, nil); code != 1 || tokenOut.Len() != 0 {
		t.Fatalf("github-token = %q (%d)", tokenOut.String(), code)
	}
}

func TestGitHubTokenPrintsATokenForTheCommandsRepository(t *testing.T) {
	agent := &fakeAgent{}
	local := startAgent(t, agent)
	run := func(args []string, env map[string]string) (string, string, int) {
		var out, errOut bytes.Buffer
		code := GitHubToken(context.Background(), args, &out, &errOut, local, func(k string) string { return env[k] },
			func() string { return "https://github.com/acme/origin.git" })
		return out.String(), errOut.String(), code
	}
	if out, _, code := run([]string{"pr", "create", "-R", "acme/flag"}, nil); out != "ghs_for_acme/flag\n" || code != 0 {
		t.Fatalf("with -R = %q (%d)", out, code)
	}
	if out, _, _ := run([]string{"pr", "create"}, map[string]string{"GH_REPO": "acme/env"}); out != "ghs_for_acme/env\n" {
		t.Fatalf("with GH_REPO = %q", out)
	}
	if out, _, _ := run([]string{"pr", "create"}, nil); out != "ghs_for_acme/origin\n" {
		t.Fatalf("from origin = %q", out)
	}

	agent.fail = "no installation"
	if out, _, code := run(nil, map[string]string{"GH_TOKEN": "gho_fallback"}); out != "gho_fallback\n" || code != 0 {
		t.Fatalf("fallback = %q (%d)", out, code)
	}
	if out, errOut, code := run(nil, nil); out != "" || code != 1 || !strings.Contains(errOut, "no installation") {
		t.Fatalf("without a fallback = %q, %q (%d)", out, errOut, code)
	}
}

func TestHelperGetsGitLabSubgroupCredentialWithoutGitHubFallback(t *testing.T) {
	agent := &fakeAgent{}
	local := startAgent(t, agent)
	request := "protocol=https\nhost=gitlab.com\npath=acme/platform/app.git\n\n"
	out, _, code := runHelper(local, "get", request, "github-secret")
	if code != 0 || !strings.Contains(out, "password=ghs_for_gitlab.com/acme/platform/app") {
		t.Fatalf("get = %q (%d)", out, code)
	}
	if agent.requests[0].Repo != "gitlab.com/acme/platform/app" {
		t.Fatalf("repo = %q", agent.requests[0].Repo)
	}
	agent.fail = "offline"
	out, _, _ = runHelper(local, "get", request, "github-secret")
	if out != "" {
		t.Fatalf("GitHub fallback reached GitLab: %q", out)
	}
}

func TestHelperRefusesMalformedGitLabPathsAndOtherHosts(t *testing.T) {
	agent := &fakeAgent{}
	local := startAgent(t, agent)
	for _, request := range []string{
		"protocol=https\nhost=gitlab.com\npath=acme/../app.git\n\n",
		"protocol=https\nhost=gitlab.com.evil.test\npath=acme/app.git\n\n",
		"protocol=https\nhost=gitlab.com\n\n",
	} {
		out, _, _ := runHelper(local, "get", request, "github-secret")
		if out != "" {
			t.Fatalf("credential for invalid request: %q", out)
		}
	}
	if len(agent.requests) != 0 {
		t.Fatalf("invalid request reached agent: %+v", agent.requests)
	}
}

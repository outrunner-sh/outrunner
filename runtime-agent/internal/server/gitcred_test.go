package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/workspace"
)

// gitCredentialCall posts to POST /git-credential with token.
func gitCredentialCall(t *testing.T, url, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url+"/git-credential", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestGitCredentialIsOffWithoutTheControlPlane(t *testing.T) {
	ts := httptest.NewServer(New("s", workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	if status, out := gitCredentialCall(t, ts.URL, "anything", `{}`); status != http.StatusNotFound || out["error"] == "" {
		t.Fatalf("status = %d, %v", status, out)
	}
}

// The helpers on the box get the control plane's token through the agent,
// with the agent's credential token only, and the control plane's refusal
// as it gave it.
func TestGitCredentialFromTheControlPlane(t *testing.T) {
	refuse := ""
	refuseWith := http.StatusForbidden
	var asked []string
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		asked = append(asked, string(body))
		if refuse != "" {
			w.WriteHeader(refuseWith)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": refuse})
			return
		}
		_, _ = w.Write([]byte(`{"token":"ghs_installation","expiresAt":"2999-01-01T00:00:00Z","identity":"app"}`))
	}))
	defer cp.Close()
	root := t.TempDir()
	svc := workspace.NewService(root)
	svc.RelayExecutable = "/bin/runtime-agent"
	if err := svc.UseGitCredential(&gitcred.Client{Config: gitcred.Config{AppURL: cp.URL, SandboxID: "sbx", Secret: "s"}, HTTP: cp.Client()}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New("s", svc).Handler())
	defer ts.Close()
	if err := svc.Announce(ts.Listener.Addr()); err != nil {
		t.Fatal(err)
	}
	addrFile, tokenFile := workspace.GitCredentialPaths(root)
	data, _ := os.ReadFile(tokenFile)
	token := strings.TrimSpace(string(data))

	if status, _ := gitCredentialCall(t, ts.URL, "wrong", `{}`); status != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", status)
	}
	if status, _ := gitCredentialCall(t, ts.URL, token, `{"repo":"not/a/repo"}`); status != http.StatusBadRequest {
		t.Fatalf("invalid repo: %d", status)
	}
	status, out := gitCredentialCall(t, ts.URL, token, `{"repo":"acme/widgets"}`)
	if status != http.StatusOK || out["token"] != "ghs_installation" || out["expiresAt"] != "2999-01-01T00:00:00Z" {
		t.Fatalf("token: %d %v", status, out)
	}
	if len(asked) != 1 || asked[0] != `{"repo":"acme/widgets"}` {
		t.Fatalf("control plane asked %q", asked)
	}
	if status, _ := gitCredentialCall(t, ts.URL, token, `{"repo":"acme/widgets","erase":true}`); status != http.StatusNoContent {
		t.Fatalf("erase: %d", status)
	}

	// Outrunner saying no on purpose is a refusal the helpers don't fall
	// back from; its failing is not.
	refuse = "Outrunner's GitHub App can't reach acme/widgets"
	if status, out := gitCredentialCall(t, ts.URL, token, `{"repo":"acme/widgets"}`); status != http.StatusConflict || out["error"] != refuse {
		t.Fatalf("refusal: %d %v", status, out)
	}
	refuse, refuseWith = "Outrunner couldn't get a GitHub token. Try again.", http.StatusBadGateway
	if status, out := gitCredentialCall(t, ts.URL, token, `{"repo":"acme/widgets"}`); status != http.StatusBadGateway || out["error"] != refuse {
		t.Fatalf("failure: %d %v", status, out)
	}

	// git's helper, end to end, through the address the agent announced.
	refuse = ""
	var stdout, stderr bytes.Buffer
	gitcred.Helper(context.Background(), "get", strings.NewReader("protocol=https\nhost=github.com\npath=acme/other.git\n\n"), &stdout, &stderr,
		gitcred.Local{AddrFile: addrFile, TokenFile: tokenFile}, "")
	if stdout.String() != "username=x-access-token\npassword=ghs_installation\n" {
		t.Fatalf("helper = %q, %q", stdout.String(), stderr.String())
	}
}

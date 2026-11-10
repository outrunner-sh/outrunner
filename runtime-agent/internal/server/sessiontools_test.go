package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/sessiontools"
	"runtime-agent/internal/workspace"
)

// A session's `outrunner-session` reaches the control plane through the
// agent, signed for its purpose and naming its session, and prints what the
// control plane answered; a call for a session this box doesn't have, or
// from outside a session, goes nowhere.
func TestSessionToolsReachTheControlPlane(t *testing.T) {
	var got []sessiontools.Call
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		want := gitcred.SignFor(sessiontools.Purpose, "secret", "sbx", r.Header.Get("X-Outrunner-Timestamp"), body)
		if r.URL.Path != sessiontools.Route || r.Header.Get("X-Outrunner-Signature") != want || r.Header.Get("X-Outrunner-Sandbox") != "sbx" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(sessiontools.Answer{Error: "bad signature"})
			return
		}
		var call sessiontools.Call
		_ = json.Unmarshal(body, &call)
		got = append(got, call)
		_ = json.NewEncoder(w).Encode(sessiontools.Answer{Text: "Suggested: it waits for you in Settings → Learnings."})
	}))
	defer cp.Close()

	root := t.TempDir()
	svc := workspace.NewService(root)
	svc.RelayExecutable = "/bin/runtime-agent"
	if err := svc.UseGitCredential(&gitcred.Client{Config: gitcred.Config{AppURL: cp.URL, SandboxID: "sbx", Secret: "secret"}, HTTP: cp.Client()}); err != nil {
		t.Fatal(err)
	}
	writeFacts(t, root, "ws-1")
	envDir := filepath.Join(root, "envroot", "ws-1")
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(envDir, ".env"), []byte("OUTRUNNER_CANARY=canary-2682b7c55940\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New("s", svc).Handler())
	defer ts.Close()
	if err := svc.Announce(ts.Listener.Addr()); err != nil {
		t.Fatal(err)
	}
	wrapper, err := os.ReadFile(filepath.Join(root, ".outrunner", "bin", sessiontools.CommandName))
	if err != nil || !strings.Contains(string(wrapper), "'/bin/runtime-agent' session-tool --root") {
		t.Fatalf("wrapper = %q, %v", wrapper, err)
	}

	addrFile, tokenFile := workspace.GitCredentialPaths(root)
	local := sessiontools.Local{AddrFile: addrFile, TokenFile: tokenFile}
	run := func(session string, args ...string) (int, string, string) {
		var stdout, stderr bytes.Buffer
		env := func(name string) string {
			if name == sessiontools.SessionEnv {
				return session
			}
			return ""
		}
		code := sessiontools.Main(context.Background(), args, env, strings.NewReader(""), &stdout, &stderr, local)
		return code, stdout.String(), stderr.String()
	}

	code, out, errOut := run("ws-1", "suggest-learning", "--org", "--title", "Commits", "Use", "Conventional", "Commits.")
	if code != 0 || !strings.Contains(out, "Settings → Learnings") {
		t.Fatalf("suggest-learning = %d, %q, %q", code, out, errOut)
	}
	if len(got) != 1 || got[0].Workspace != "ws-1" || got[0].Tool != "suggest_learning" ||
		string(got[0].Args) != `{"body":"Use Conventional Commits.","scope":"org","title":"Commits"}` {
		t.Fatalf("control plane got %+v", got)
	}

	if code, _, errOut := run("ws-other", "suggest-learning", "--title", "T", "x"); code != 1 || !strings.Contains(errOut, "no such session") {
		t.Fatalf("another box's session = %d, %q", code, errOut)
	}
	if code, _, errOut := run("", "suggest-learning", "--title", "T", "x"); code != 1 || !strings.Contains(errOut, sessiontools.SessionEnv) {
		t.Fatalf("outside a session = %d, %q", code, errOut)
	}
	if len(got) != 1 {
		t.Fatalf("refused calls reached the control plane: %+v", got)
	}

	// A secret on the box is masked in what a tool sends out (NEE-268).
	if code, _, errOut := run("ws-1", "suggest-learning", "--org", "--title", "Key", "It's", "canary-2682b7c55940"); code != 0 {
		t.Fatalf("suggest-learning with a secret = %d, %q", code, errOut)
	}
	if len(got) != 2 || string(got[1].Args) != `{"body":"It's ***","scope":"org","title":"Key"}` {
		t.Fatalf("control plane got %+v", got)
	}
}

// Without the control plane, the sessions have no commands, and none is
// answered.
func TestSessionToolsAreOffWithoutTheControlPlane(t *testing.T) {
	ts := httptest.NewServer(New("s", workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/session-tools", strings.NewReader(`{"workspace":"ws-1","tool":"suggest_learning"}`))
	req.Header.Set("Authorization", "Bearer anything")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func writeFacts(t *testing.T, root, id string) {
	t.Helper()
	path := filepath.Join(root, "facts", id+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

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

	"runtime-agent/internal/preview"
	"runtime-agent/internal/workspace"
)

// `runtime-agent preview` asks the agent with the session's ask token, the
// agent asks the control plane signed with its secret, and the link comes
// back to print; a refusal comes back as the control plane's sentence.
func TestAPreviewIsMadeFromTheSessionThroughTheAgent(t *testing.T) {
	var asked map[string]any
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &asked)
		if want := preview.Sign("box-secret", "sandbox-1", r.Header.Get("X-Outrunner-Timestamp"), body); r.Header.Get("X-Outrunner-Signature") != want {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"Bad signature."}`)
			return
		}
		if asked["port"] == float64(8080) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"not the agent's own (8080)"}`)
			return
		}
		_, _ = io.WriteString(w, `{"preview":{"id":"p1","port":3000,"label":"Web app","mode":"login","url":"https://abc.outrunner-preview.com/"}}`)
	}))
	defer cp.Close()

	root := t.TempDir()
	svc := workspace.NewService(root)
	svc.RelayExecutable = "/usr/local/bin/runtime-agent"
	svc.UsePreviews(&preview.Client{AppURL: cp.URL, SandboxID: "sandbox-1", Secret: "box-secret"})
	ts := httptest.NewServer(New("test-secret", svc).Handler())
	defer ts.Close()
	if err := svc.Announce(ts.Listener.Addr()); err != nil {
		t.Fatal(err)
	}
	_, tokenFile := workspace.AskPaths(root, "ws-p")
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("session-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	args := []string{"--root", root, "--workspace", "ws-p", "--label", "Web app", "3000"}
	if code := preview.Main(context.Background(), args, &out, &errOut, workspace.AskPaths, nil); code != 0 {
		t.Fatalf("preview = %d: %s", code, errOut.String())
	}
	if got := strings.TrimSpace(out.String()); got != "https://abc.outrunner-preview.com/" {
		t.Fatalf("printed %q", got)
	}
	if asked["workspaceId"] != "ws-p" || asked["label"] != "Web app" {
		t.Fatalf("control plane was asked %v", asked)
	}

	out.Reset()
	errOut.Reset()
	args = []string{"--root", root, "--workspace", "ws-p", "8080"}
	if code := preview.Main(context.Background(), args, &out, &errOut, workspace.AskPaths, nil); code != 1 {
		t.Fatalf("preview of 8080 = %d", code)
	}
	if !strings.Contains(errOut.String(), "not the agent's own (8080)") {
		t.Fatalf("stderr = %q", errOut.String())
	}

	// Another session's token, or none, makes nothing.
	req, _ := http.NewRequest("POST", ts.URL+"/workspaces/ws-p/preview", strings.NewReader(`{"port":3000}`))
	req.Header.Set("Authorization", "Bearer wrong")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("preview with a wrong token = %v %v, want 401", resp.StatusCode, err)
	}
}

// A box the control plane didn't launch with the means to ask it (the
// desktop app) makes no previews, and says so.
func TestNoPreviewsWithoutTheControlPlane(t *testing.T) {
	root := t.TempDir()
	svc := workspace.NewService(root)
	ts := httptest.NewServer(New("test-secret", svc).Handler())
	defer ts.Close()
	_, tokenFile := workspace.AskPaths(root, "ws-p")
	_ = os.MkdirAll(filepath.Dir(tokenFile), 0o700)
	_ = os.WriteFile(tokenFile, []byte("session-token\n"), 0o600)
	req, _ := http.NewRequest("POST", ts.URL+"/workspaces/ws-p/preview", strings.NewReader(`{"port":3000}`))
	req.Header.Set("Authorization", "Bearer session-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("preview on the desktop = %v %v, want 404", resp.StatusCode, err)
	}
}

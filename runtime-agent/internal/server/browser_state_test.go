package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/desktop"
	"runtime-agent/internal/workspace"
)

// The browser's sign-ins are the user's: only the session, with its ask
// token, reads them, only where there's a desktop browser, and an origin
// that isn't one is the caller's to fix (400), not a failure (500).
func TestASessionReadsTheBrowsersSignInsThroughTheAgent(t *testing.T) {
	root := t.TempDir()
	svc := workspace.NewService(root)
	ts := httptest.NewServer(New("test-secret", svc).Handler())
	defer ts.Close()
	_, tokenFile := workspace.AskPaths(root, "ws-b")
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("session-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ask := func(token, body string) int {
		t.Helper()
		req, _ := http.NewRequest("POST", ts.URL+"/workspaces/ws-b/browser-state", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if status := ask("wrong", `{}`); status != http.StatusUnauthorized {
		t.Errorf("with a wrong token = %d, want 401", status)
	}
	if status := ask("session-token", `{}`); status != http.StatusConflict {
		t.Errorf("with no desktop = %d, want 409", status)
	}

	toolbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"inactive"}`))
	}))
	defer toolbox.Close()
	svc.RelayExecutable = "/opt/runtime-agent"
	svc.DesktopToolbox = toolbox.URL
	svc.Browser = &desktop.Browser{Port: 1, Profile: t.TempDir(), Display: desktop.Display}
	if status := ask("session-token", `{"origins":["localhost:3000"]}`); status != http.StatusBadRequest {
		t.Errorf("with an origin that isn't one = %d, want 400", status)
	}
}

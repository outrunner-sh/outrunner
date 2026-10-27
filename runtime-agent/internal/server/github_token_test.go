package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"runtime-agent/internal/workspace"
)

func TestASessionsGitHubTokenIsCheckedBeforeItIsKept(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const secret = "test-secret"
	ts := httptest.NewServer(New(secret, workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	call := controlCall(t, ts.URL, secret)
	folder := t.TempDir()

	for _, bad := range []string{"ghs_split\nline-0123456789", "ghs_'quoted'-0123456789", "short"} {
		if code, out := call("ws-g", "POST", "/workspaces", map[string]any{
			"workspaceId": "ws-g", "repoPath": folder, "githubToken": bad,
		}); code != http.StatusBadRequest {
			t.Errorf("create with githubToken %q = %d %v, want 400", bad, code, out)
		}
	}
	if code, out := call("ws-g", "POST", "/workspaces", map[string]any{
		"workspaceId": "ws-g", "repoPath": folder, "githubToken": "ghs_0123456789abcdefghijklmnop",
	}); code != http.StatusOK {
		t.Fatalf("create = %d %v", code, out)
	}
}

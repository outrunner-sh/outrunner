package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestASessionsAgentIsCheckedAtCreateAndListed(t *testing.T) {
	const secret = "test-secret"
	ts := httptest.NewServer(New(secret, workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	call := func(workspaceID, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, ts.URL+path, &buf)
		req.Header.Set("Authorization", "Bearer "+mintToken(protocol.RuntimeTokenClaims{
			WorkspaceID: workspaceID, ProjectID: "local", ComputerID: "c", UserID: "desktop",
			Exp: time.Now().Add(time.Minute).Unix(),
		}, secret))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// Refused as a bad request, not a failure: an agent this one doesn't run,
	// and Codex on a Runtime Computer.
	for _, body := range []map[string]any{
		{"workspaceId": "ws-x", "repoPath": t.TempDir(), "agent": "gemini"},
		{"workspaceId": "ws-x", "branch": "b", "baseBranch": "main", "agent": "codex"},
	} {
		if code, out := call("ws-x", "POST", "/workspaces", body); code != http.StatusBadRequest {
			t.Errorf("create %v = %d %v, want 400", body, code, out)
		}
	}

	if code, out := call("ws-c", "POST", "/workspaces", map[string]any{"workspaceId": "ws-c", "repoPath": t.TempDir(), "agent": "codex"}); code != http.StatusOK {
		t.Fatalf("create a Codex session = %d %v", code, out)
	}
	_, out := call(protocol.ListingWorkspaceID, "GET", "/workspaces", nil)
	list, _ := out["workspaces"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["agent"] != "codex" {
		t.Errorf("listing = %v, want the session as codex", out)
	}
}

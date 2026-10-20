package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestASessionsAgentIsChosenAtCreateAndListed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const secret = "test-secret"
	ts := httptest.NewServer(New(secret, workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	call := controlCall(t, ts.URL, secret)
	folder := t.TempDir()

	for _, bad := range []string{"gemini", "Codex", "claude "} {
		if code, out := call("ws-a", "POST", "/workspaces", map[string]any{
			"workspaceId": "ws-a", "repoPath": folder, "agent": bad,
		}); code != http.StatusBadRequest {
			t.Errorf("create with agent %q = %d %v, want 400", bad, code, out)
		}
	}
	if code, out := call("ws-a", "POST", "/workspaces", map[string]any{
		"workspaceId": "ws-a", "repoPath": folder, "agent": "codex", "model": "gpt-6-luna",
	}); code != http.StatusOK {
		t.Fatalf("create = %d %v", code, out)
	}
	if code, out := call("ws-c", "POST", "/workspaces", map[string]any{
		"workspaceId": "ws-c", "repoPath": folder,
	}); code != http.StatusOK {
		t.Fatalf("create = %d %v", code, out)
	}
	_, out := call(protocol.ListingWorkspaceID, "GET", "/workspaces", nil)
	agents := map[string]any{}
	for _, entry := range out["workspaces"].([]any) {
		session := entry.(map[string]any)
		agents[session["workspaceId"].(string)] = session["agent"]
	}
	if agents["ws-a"] != "codex" || agents["ws-c"] != nil {
		t.Errorf("listed agents = %v, want codex, and none (Claude) for the other", agents)
	}

	// Gateways serve Claude's API: a Codex session can't switch to one.
	if code, out := call("ws-a", "POST", "/workspaces/ws-a/model", map[string]string{
		"model": "z-ai/glm-5.3", "gateway": "openrouter", "token": testGatewayKey,
	}); code != http.StatusBadRequest {
		t.Errorf("a Codex session onto a gateway = %d %v, want 400", code, out)
	}
}

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestASessionsAgentIsChosenAtCreateAndItsCredentialMustFitIt(t *testing.T) {
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

	// A session's own credential: checked like a gateway key, and only for its agent.
	const openAIKey = "sk-proj-0123456789abcdef0123456789"
	for _, c := range []struct {
		workspace string
		body      map[string]string
		want      int
	}{
		{"ws-a", map[string]string{"kind": "chatgpt", "token": openAIKey}, http.StatusBadRequest},
		{"ws-a", map[string]string{"kind": "openai-api-key"}, http.StatusBadRequest},
		{"ws-a", map[string]string{"kind": "openai-api-key", "token": "short"}, http.StatusBadRequest},
		{"ws-a", map[string]string{"kind": "openai-api-key", "token": openAIKey + "'; rm -rf ~"}, http.StatusBadRequest},
		{"ws-a", map[string]string{"kind": "none", "token": openAIKey}, http.StatusBadRequest},
		{"ws-a", map[string]string{"kind": "claude-oauth-token", "token": openAIKey}, http.StatusBadRequest},
		{"ws-c", map[string]string{"kind": "openai-api-key", "token": openAIKey}, http.StatusBadRequest},
		{"ws-x", map[string]string{"kind": "openai-api-key", "token": openAIKey}, http.StatusNotFound},
		{"ws-a", map[string]string{"kind": "openai-api-key", "token": openAIKey}, http.StatusOK},
		{"ws-a", map[string]string{"kind": "none"}, http.StatusOK},
		{"ws-c", map[string]string{"kind": "anthropic-api-key", "token": "sk-ant-api03-0123456789abcdef0123"}, http.StatusOK},
	} {
		if code, out := call(c.workspace, "POST", "/workspaces/"+c.workspace+"/auth", c.body); code != c.want {
			t.Errorf("auth %s %v = %d %v, want %d", c.workspace, c.body, code, out, c.want)
		}
	}

	// An unknown session says so in the error envelope, unlike an agent from
	// before the route (a bare 404).
	if _, out := call("ws-x", "POST", "/workspaces/ws-x/auth", map[string]string{"kind": "none"}); out["error"] == nil || out["error"].(map[string]any)["code"] != "NOT_FOUND" {
		t.Errorf("auth on an unknown session = %v, want the NOT_FOUND envelope", out)
	}

	// Gateways serve Claude's API: a Codex session can't switch to one.
	if code, out := call("ws-a", "POST", "/workspaces/ws-a/model", map[string]string{
		"model": "z-ai/glm-5.3", "gateway": "openrouter", "token": testGatewayKey,
	}); code != http.StatusBadRequest {
		t.Errorf("a Codex session onto a gateway = %d %v, want 400", code, out)
	}
}

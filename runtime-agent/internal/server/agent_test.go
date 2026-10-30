package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"slices"
	"strings"
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
		{"ws-a", map[string]string{"kind": "codex-access-token", "token": "synthetic-workspace-token-" + strings.Repeat("a", 800)}, http.StatusOK},
		{"ws-a", map[string]string{"kind": "codex-access-token"}, http.StatusBadRequest},
		{"ws-a", map[string]string{"kind": "codex-access-token", "token": openAIKey + "\n"}, http.StatusBadRequest},
		{"ws-c", map[string]string{"kind": "codex-access-token", "token": openAIKey}, http.StatusBadRequest},
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

	// Of the gateways, only OpenRouter serves OpenAI's API, as Codex needs:
	// a Codex session can't switch to the others.
	if code, out := call("ws-a", "POST", "/workspaces/ws-a/model", map[string]string{
		"model": "glm-5.3", "gateway": "zai", "token": testGatewayKey,
	}); code != http.StatusBadRequest {
		t.Errorf("a Codex session onto Z.ai's Anthropic API = %d %v, want 400", code, out)
	}
}

func TestHealthSaysWhichAgentsTheComputerRuns(t *testing.T) {
	ts := httptest.NewServer(New("s", workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body protocol.Health
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Status != "ok" || len(body.Agents) == 0 || body.Agents[0] != "claude" {
		t.Errorf("health = %+v, %v; want ok and Claude first among the agents", body, err)
	}
	if !slices.Contains(body.Features, protocol.FeatureCodexGateway) {
		t.Errorf("health features = %q, want %s: Outrunner's models in Codex", body.Features, protocol.FeatureCodexGateway)
	}
	if !slices.Contains(body.Features, protocol.FeatureCodexAccessToken) {
		t.Error("health omits Codex access-token capability")
	}
	if !slices.Contains(body.Features, protocol.FeatureCodexAccount) {
		t.Error("health omits the host-managed Codex account capability required by controller delivery")
	}
	_, err = exec.LookPath("codex")
	if hasCodex := slices.Contains(body.Agents, "codex"); hasCodex != (err == nil) {
		t.Errorf("health lists codex = %v, but codex is installed = %v", hasCodex, err == nil)
	}
}

func TestARestoreNamesAKnownAgentAndAValidCredential(t *testing.T) {
	const secret = "test-secret"
	ts := httptest.NewServer(New(secret, workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	call := controlCall(t, ts.URL, secret)
	for _, extra := range []map[string]any{
		{"agent": "gemini"},
		{"auth": map[string]string{"kind": "chatgpt", "token": testGatewayKey}},
		{"auth": map[string]string{"kind": "openai-api-key"}},
	} {
		req := map[string]any{"branch": "b", "sessionId": nil, "downloads": []map[string]string{{"artifact": "bundle", "url": "http://x/b"}}}
		for k, v := range extra {
			req[k] = v
		}
		if code, out := call("ws-r", "POST", "/workspaces/ws-r/restore", req); code != http.StatusBadRequest {
			t.Errorf("restore with %v = %d %v, want 400", extra, code, out)
		}
	}
}

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"slices"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

// testGatewayKey is shaped like an OpenRouter key.
const testGatewayKey = "sk-or-v1-0123456789abcdef0123456789abcdef"

func TestASessionsModelIsSetAtCreateAndSwitched(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed") // the switch asks tmux whether the session runs
	}
	t.Setenv("HOME", t.TempDir())
	const secret = "test-secret"
	ts := httptest.NewServer(New(secret, workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	folder := t.TempDir() // not a repository: the session works in it in place

	call := controlCall(t, ts.URL, secret)
	listedModel := func() any {
		t.Helper()
		_, out := call(protocol.ListingWorkspaceID, "GET", "/workspaces", nil)
		list, _ := out["workspaces"].([]any)
		if len(list) != 1 {
			t.Fatalf("listing = %v", out)
		}
		return list[0].(map[string]any)["model"]
	}

	if code, out := call("ws-m", "POST", "/workspaces", map[string]any{
		"workspaceId": "ws-m", "repoPath": folder, "model": "--dangerously-skip-permissions",
	}); code != http.StatusBadRequest {
		t.Fatalf("create with a flag as the model = %d %v, want 400", code, out)
	}
	if code, out := call("ws-m", "POST", "/workspaces", map[string]any{
		"workspaceId": "ws-m", "repoPath": folder, "model": "sonnet",
	}); code != http.StatusOK {
		t.Fatalf("create = %d %v", code, out)
	}
	if got := listedModel(); got != "sonnet" {
		t.Fatalf("listed model = %v, want sonnet", got)
	}

	if code, _ := call("ws-m", "POST", "/workspaces/ws-m/model", map[string]string{"model": "a b"}); code != http.StatusBadRequest {
		t.Errorf("invalid model = %d, want 400", code)
	}
	if code, _ := call("ws-x", "POST", "/workspaces/ws-x/model", map[string]string{"model": "opus"}); code != http.StatusNotFound {
		t.Errorf("unknown workspace = %d, want 404", code)
	}
	if code, out := call("ws-m", "POST", "/workspaces/ws-m/model", map[string]string{"model": "opus"}); code != http.StatusOK || out["result"] != "opus" {
		t.Fatalf("switch = %d %v", code, out)
	}
	if got := listedModel(); got != "opus" {
		t.Errorf("listed model after the switch = %v, want opus", got)
	}
	if code, _ := call("ws-m", "POST", "/workspaces/ws-m/model", map[string]string{"model": "opus", "effort": "--max"}); code != http.StatusBadRequest {
		t.Errorf("invalid effort = %d, want 400", code)
	}
	// The effort is answered, so the web app can tell it was applied.
	if code, out := call("ws-m", "POST", "/workspaces/ws-m/model", map[string]string{"model": "opus", "effort": "xhigh"}); code != http.StatusOK || out["effort"] != "xhigh" {
		t.Fatalf("switch at an effort = %d %v", code, out)
	}

	for _, bad := range []map[string]string{
		{"model": "z-ai/glm-5.3", "gateway": "openrouter"},                         // no key
		{"model": "opus", "token": testGatewayKey},                                 // a key with no gateway
		{"model": "z-ai/glm-5.3", "gateway": "https://evil.example", "token": "k"}, // not a gateway
		{"model": "z-ai/glm-5.3", "gateway": "openrouter", "token": testGatewayKey + "'; rm -rf ~"},
	} {
		if code, _ := call("ws-m", "POST", "/workspaces/ws-m/model", bad); code != http.StatusBadRequest {
			t.Errorf("%v = %d, want 400", bad, code)
		}
	}
	if code, out := call("ws-m", "POST", "/workspaces/ws-m/model", map[string]string{
		"model": "z-ai/glm-5.3", "gateway": "openrouter", "token": testGatewayKey,
	}); code != http.StatusOK {
		t.Fatalf("switch to OpenRouter = %d %v", code, out)
	}
	_, out := call(protocol.ListingWorkspaceID, "GET", "/workspaces", nil)
	listed := out["workspaces"].([]any)[0].(map[string]any)
	if listed["gateway"] != "openrouter" || listed["model"] != "z-ai/glm-5.3" {
		t.Errorf("listing = %v, want the gateway and its model", listed)
	}
	if _, has := listed["token"]; has {
		t.Error("the listing carries the key")
	}
}

func TestHealthSaysWhichGatewaysTheAgentSupports(t *testing.T) {
	ts := httptest.NewServer(New("s", workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Status   string   `json:"status"`
		Gateways []string `json:"gateways"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Status != "ok" || !slices.Contains(body.Gateways, "openrouter") {
		t.Errorf("health = %+v, %v; want ok and the gateways, OpenRouter among them", body, err)
	}
}

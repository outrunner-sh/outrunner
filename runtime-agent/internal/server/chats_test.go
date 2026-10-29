package server

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestASessionsChatsAreMadeNamedAndEnded(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const secret = "test-secret"
	ts := httptest.NewServer(New(secret, workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	call := controlCall(t, ts.URL, secret)

	_, health := call("ws-a", "GET", "/health", nil)
	if features, _ := health["features"].([]any); !slices.Contains(features, any(protocol.FeatureChats)) {
		t.Fatalf("health = %v, want the chats feature", health)
	}
	if code, out := call("ws-a", "POST", "/workspaces", map[string]any{"workspaceId": "ws-a", "repoPath": t.TempDir()}); code != http.StatusOK {
		t.Fatalf("create = %d %v", code, out)
	}
	for _, c := range []struct {
		name string
		body map[string]any
		want int
	}{
		{"the main chat's id", map[string]any{"chatId": "main", "noStart": true}, http.StatusBadRequest},
		{"an id no file can be named", map[string]any{"chatId": "../c", "noStart": true}, http.StatusBadRequest},
		{"a side chat about nothing", map[string]any{"chatId": "c9", "side": true, "noStart": true}, http.StatusBadRequest},
		{"a fork of no chat", map[string]any{"chatId": "c9", "from": "c8", "noStart": true}, http.StatusNotFound},
		{"an agent there isn't", map[string]any{"chatId": "c9", "agent": "gemini", "noStart": true}, http.StatusBadRequest},
		{"a chat", map[string]any{"chatId": "c1", "noStart": true}, http.StatusOK},
		{"the same chat again", map[string]any{"chatId": "c1", "noStart": true}, http.StatusOK},
	} {
		if code, out := call("ws-a", "POST", "/workspaces/ws-a/chats", c.body); code != c.want {
			t.Errorf("%s: create chat = %d %v, want %d", c.name, code, out, c.want)
		}
	}
	// Another workspace's token can't reach this one's chats.
	if code, _ := call("ws-b", "POST", "/workspaces/ws-a/chats", map[string]any{"chatId": "c2", "noStart": true}); code != http.StatusUnauthorized {
		t.Errorf("create with another workspace's token = %d, want 401", code)
	}
	for _, c := range []struct {
		query string
		want  int
	}{
		{"", http.StatusOK},
		{"?chat=main", http.StatusOK},
		{"?chat=c1", http.StatusOK},
		{"?chat=c2", http.StatusNotFound},
		{"?chat=C1", http.StatusBadRequest},
	} {
		if code, out := call("ws-a", "GET", "/workspaces/ws-a/summary"+c.query, nil); code != c.want {
			t.Errorf("summary%s = %d %v, want %d", c.query, code, out, c.want)
		}
	}
	if code, _ := call("ws-a", "POST", "/workspaces/ws-a/chats/main/delete", nil); code != http.StatusBadRequest {
		t.Errorf("deleting the main chat = %d, want 400: it ends with its session", code)
	}
	if code, out := call("ws-a", "POST", "/workspaces/ws-a/chats/c1/delete", nil); code != http.StatusOK {
		t.Fatalf("delete chat = %d %v", code, out)
	}
	if code, _ := call("ws-a", "POST", "/workspaces/ws-a/interrupt?chat=c1", nil); code != http.StatusNotFound {
		t.Errorf("interrupting a deleted chat = %d, want 404", code)
	}
}

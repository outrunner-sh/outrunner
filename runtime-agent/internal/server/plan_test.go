package server

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestTheAgentSaysItTakesPlanModeAndCompacts(t *testing.T) {
	ts := httptest.NewServer(New("test-secret", workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	code, out := controlCall(t, ts.URL, "test-secret")("ws-h", "GET", "/health", nil)
	features, _ := out["features"].([]any)
	if code != http.StatusOK || !slices.Contains(features, any(protocol.FeaturePlanMode)) || !slices.Contains(features, any(protocol.FeatureCompact)) {
		t.Fatalf("health = %d %v, want plan-mode and compact", code, out)
	}
}

func TestAPromptInAModeTheAgentDoesntKnowIsRefused(t *testing.T) {
	ts := httptest.NewServer(New("test-secret", workspace.NewService(t.TempDir())).Handler())
	defer ts.Close()
	call := controlCall(t, ts.URL, "test-secret")
	if code, out := call("ws-p", "POST", "/workspaces/ws-p/message", map[string]any{"content": "hi", "mode": "yolo"}); code != http.StatusBadRequest {
		t.Errorf("mode yolo = %d %v, want 400", code, out)
	}
	// A compaction of a session the agent never made.
	if code, out := call("ws-p", "POST", "/workspaces/ws-p/compact", nil); code != http.StatusNotFound {
		t.Errorf("compact of an unknown session = %d %v, want 404", code, out)
	}
}

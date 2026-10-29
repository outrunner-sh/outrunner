package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"runtime-agent/internal/workspace"
)

func TestInvalidGuideIsRefusedBeforeCreatingAWorkspace(t *testing.T) {
	for _, tc := range []struct{ name, guide, message string }{
		{"oversize", strings.Repeat("x", (32<<10)+1), "guide too large"},
		{"NUL", "hello\x00world", "guide contains NUL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			ts := httptest.NewServer(New("test-secret", workspace.NewService(root)).Handler())
			defer ts.Close()
			code, out := controlCall(t, ts.URL, "test-secret")("ws-g", "POST", "/workspaces", map[string]any{
				"workspaceId": "ws-g", "branch": "b", "baseBranch": "main", "guide": tc.guide,
			})
			apiError, _ := out["error"].(map[string]any)
			message, _ := apiError["message"].(string)
			if code != http.StatusBadRequest || !strings.Contains(message, tc.message) {
				t.Fatalf("create = %d %v", code, out)
			}
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 0 {
				t.Fatalf("invalid guide wrote files: %v (%v)", entries, err)
			}
		})
	}
}

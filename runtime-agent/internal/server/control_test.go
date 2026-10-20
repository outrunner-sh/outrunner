package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
)

// controlCaller is a control-plane request to a test server: a JSON body (or
// none), signed for the workspace it names, answered by its status and body.
type controlCaller func(workspaceID, method, path string, body any) (int, map[string]any)

func controlCall(t *testing.T, baseURL, secret string) controlCaller {
	return func(workspaceID, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, baseURL+path, &buf)
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
}

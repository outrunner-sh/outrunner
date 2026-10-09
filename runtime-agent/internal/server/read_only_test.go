package server

import (
	"net/http"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
)

// A teammate's read-only token follows the conversation and nothing else: not
// the terminal, not a control route, whatever it is presented as.
func TestAReadOnlyTokenOnlyWatches(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()
	readOnly := mintToken(protocol.RuntimeTokenClaims{
		WorkspaceID: f.workspaceID, ProjectID: "p", ComputerID: "c", UserID: "teammate",
		Exp: time.Now().Add(time.Minute).Unix(), ReadOnly: true,
	}, f.secret)

	get := func(path, bearer string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, f.url+path, nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if code := get("/pty?token="+readOnly, ""); code != http.StatusForbidden {
		t.Errorf("terminal with a read-only token: %d, want 403", code)
	}
	if code := get("/workspaces/"+f.workspaceID+"/summary", readOnly); code != http.StatusForbidden {
		t.Errorf("control route with a read-only token: %d, want 403", code)
	}
	req, _ := http.NewRequest(http.MethodPost, f.url+"/workspaces/"+f.workspaceID+"/message", nil)
	req.Header.Set("Authorization", "Bearer "+readOnly)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST message: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("prompt with a read-only token: %d, want 403", resp.StatusCode)
	}

	// The conversation stream opens: the SSE endpoint answers 200 with a stream.
	streamReq, _ := http.NewRequest(http.MethodGet, f.url+"/events?token="+readOnly, nil)
	client := &http.Client{Timeout: 3 * time.Second}
	stream, err := client.Do(streamReq)
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusOK {
		t.Errorf("conversation stream with a read-only token: %d, want 200", stream.StatusCode)
	}
}

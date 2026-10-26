package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"runtime-agent/internal/editor"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestTheEditorOpensOnlyForItsSessionsOwnFolder(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	svc := workspace.NewService(root)
	srv := New("s", svc)
	healthz := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"alive","lastHeartbeat":0}`))
	}))
	defer healthz.Close()
	srv.Editor = &editor.Editor{Home: root, Health: healthz.URL, Start: func(context.Context, string, int) error { return nil }}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	token := func(workspaceID string) string {
		return mintToken(protocol.RuntimeTokenClaims{
			WorkspaceID: workspaceID, ProjectID: "p", ComputerID: "c", UserID: "u",
			Exp: time.Now().Add(time.Minute).Unix(),
		}, "s")
	}
	post := func(workspaceID, tok string) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/workspaces/"+workspaceID+"/editor", nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	// No session folder here.
	if res := post("ws-1", token("ws-1")); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown session: %d", res.StatusCode)
	}
	if err := os.MkdirAll(root+"/workspaces/ws-1", 0o755); err != nil {
		t.Fatal(err)
	}
	// Another session's token, or none.
	if res := post("ws-1", token("ws-2")); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("other session's token: %d", res.StatusCode)
	}
	if res := post("ws-1", ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", res.StatusCode)
	}

	res := post("ws-1", token("ws-1"))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("open: %d", res.StatusCode)
	}
	var got protocol.EditorResponse
	_ = json.NewDecoder(res.Body).Decode(&got)
	if got.Port != editor.Port || got.Folder != root+"/workspaces/ws-1" {
		t.Fatalf("got %+v", got)
	}
}

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

func TestTheBoxsServersAreListedForItsSession(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	proc := t.TempDir()
	_ = os.MkdirAll(filepath.Join(proc, "net"), 0o755)
	header := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	row := func(local, inode string) string {
		return "   0: " + local + " 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 " + inode + " 1 0 100 0 0 10 0\n"
	}
	// 3000 a dev server; 9000 this agent; 8443 the editor.
	_ = os.WriteFile(filepath.Join(proc, "net", "tcp"), []byte(header+row("00000000:0BB8", "1")+row("00000000:2328", "2")+row("00000000:20FB", "3")), 0o644)

	srv := New("s", workspace.NewService(root))
	srv.ProcRoot = proc
	srv.AgentPort = 9000
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	get := func(workspaceID, tokenFor string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/workspaces/"+workspaceID+"/ports", nil)
		req.Header.Set("Authorization", "Bearer "+mintToken(protocol.RuntimeTokenClaims{
			WorkspaceID: tokenFor, ProjectID: "p", ComputerID: "c", UserID: "u", Exp: time.Now().Add(time.Minute).Unix(),
		}, "s"))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	if res := get("ws-1", "ws-1"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("a session not on this box: %d", res.StatusCode)
	}
	_ = os.MkdirAll(filepath.Join(root, "workspaces", "ws-1"), 0o755)
	if res := get("ws-1", "ws-2"); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("another session's token: %d", res.StatusCode)
	}
	res := get("ws-1", "ws-1")
	var got protocol.PortsResponse
	_ = json.NewDecoder(res.Body).Decode(&got)
	if res.StatusCode != http.StatusOK || len(got.Ports) != 1 || got.Ports[0].Port != 3000 {
		t.Fatalf("got %d %+v", res.StatusCode, got)
	}
}

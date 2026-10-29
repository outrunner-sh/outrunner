package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/media"
	"runtime-agent/internal/workspace"
)

// A session's upload goes through the agent, which proves the session with
// its ask token and signs for the box; the control plane's refusal is passed
// on as the agent's message.
func TestASessionUploadsThroughTheAgent(t *testing.T) {
	refuse := ""
	var outrunner *httptest.Server
	outrunner = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runtime/media":
			if refuse != "" {
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = io.WriteString(w, `{"error":"`+refuse+`"}`)
				return
			}
			_, _ = io.WriteString(w, `{"id":"m1","uploadUrl":"`+outrunner.URL+`/storage"}`)
		case "/storage":
			_, _ = io.Copy(io.Discard, r.Body)
		case "/api/runtime/media/complete":
			_, _ = io.WriteString(w, `{"id":"m1","url":"https://app/m/x.png","pageUrl":"https://app/media/m1","markdown":"![After](https://app/m/x.png)","access":"public"}`)
		}
	}))
	defer outrunner.Close()

	root := t.TempDir()
	svc := workspace.NewService(root)
	ts := httptest.NewServer(New("test-secret", svc).Handler())
	defer ts.Close()
	_, tokenFile := workspace.AskPaths(root, "ws-m")
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("session-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shot := filepath.Join(root, "after.png")
	if err := os.WriteFile(shot, []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"), 0o644); err != nil {
		t.Fatal(err)
	}
	upload := func(token string) (int, map[string]any) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"path": shot, "name": "After"})
		req, _ := http.NewRequest("POST", ts.URL+"/workspaces/ws-m/media", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var answer map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&answer)
		return resp.StatusCode, answer
	}

	if status, _ := upload("wrong"); status != http.StatusUnauthorized {
		t.Fatalf("upload with a wrong token = %d, want 401", status)
	}
	// A box that can't upload says so; not a 502, which the relay would try
	// again for minutes.
	if status, _ := upload("session-token"); status != http.StatusConflict {
		t.Fatalf("upload with no control plane = %d, want 409", status)
	}

	svc.UseMedia(&media.Client{Config: gitcred.Config{AppURL: outrunner.URL, SandboxID: "sb", Secret: "s"}})
	status, answer := upload("session-token")
	if status != http.StatusOK || answer["markdown"] != "![After](https://app/m/x.png)" || !strings.HasPrefix(answer["text"].(string), "![After](https://app/m/x.png)") {
		t.Fatalf("upload = %d %v", status, answer)
	}

	refuse = "Your org has uploaded 500 files in the last day, its limit."
	status, answer = upload("session-token")
	if message := answer["error"].(map[string]any)["message"]; status != http.StatusUnprocessableEntity || message != refuse {
		t.Fatalf("refused upload = %d %v", status, answer)
	}
}

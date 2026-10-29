package preview

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The vector the web app checks too (test/preview-box-request.test.ts), so
// the two sign alike.
func TestSignMatchesTheControlPlane(t *testing.T) {
	body := []byte(`{"workspaceId":"55555555-5555-4555-8555-555555555555","port":3000,"label":"Web"}`)
	got := Sign("box-secret", "sandbox-1", "1762182000", body)
	want := "sha256=1c039b010f36c44c9592a5c97768b6e6e542a33727e05b577b81e89183b514fb"
	if got != want {
		t.Fatalf("Sign = %s, want %s", got, want)
	}
}

func TestCreateSignsTheRequestAndReadsThePreview(t *testing.T) {
	var seen *http.Request
	var body []byte
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"preview":{"id":"p1","port":5173,"label":"Web","mode":"login","url":"https://abc.outrunner-preview.com/"}}`)
	}))
	defer cp.Close()
	c := &Client{AppURL: cp.URL, SandboxID: "sandbox-1", Secret: "box-secret", Now: func() time.Time { return time.Unix(1762182000, 0) }}
	got, err := c.Create(context.Background(), "ws-1", 5173, "Web")
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != "https://abc.outrunner-preview.com/" || got.Mode != "login" || got.Port != 5173 {
		t.Fatalf("preview = %+v", got)
	}
	if seen.URL.Path != "/api/runtime/previews" || seen.Header.Get("X-Outrunner-Sandbox") != "sandbox-1" {
		t.Fatalf("request = %s %v", seen.URL.Path, seen.Header)
	}
	if want := Sign("box-secret", "sandbox-1", "1762182000", body); seen.Header.Get("X-Outrunner-Signature") != want {
		t.Fatalf("signature = %s, want %s", seen.Header.Get("X-Outrunner-Signature"), want)
	}
	var sent map[string]any
	_ = json.Unmarshal(body, &sent)
	if sent["workspaceId"] != "ws-1" || sent["port"] != float64(5173) || sent["label"] != "Web" {
		t.Fatalf("body = %s", body)
	}
}

func TestCreatePassesTheRefusalOn(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{400, `{"error":"` + "`port` is a port your server listens on" + `"}`, "`port` is a port your server listens on"},
		{404, `<html>not found</html>`, "This Outrunner doesn't make previews yet."},
		{503, ``, "Outrunner refused the preview: 503 Service Unavailable"},
	} {
		cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = io.WriteString(w, tc.body)
		}))
		_, err := (&Client{AppURL: cp.URL, SandboxID: "s", Secret: "k"}).Create(context.Background(), "ws", 8080, "")
		cp.Close()
		var refusal *Error
		if !errors.As(err, &refusal) || refusal.Status != tc.status || refusal.Message != tc.want {
			t.Fatalf("%d: err = %v, want %q", tc.status, err, tc.want)
		}
	}
}

// The workspace id goes into the agent's path escaped: an id with a slash
// in it names its own session's route, not another one.
func TestTheCLIEscapesTheWorkspaceIDInThePath(t *testing.T) {
	var rawPath string
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawPath = r.URL.RawPath
		_, _ = io.WriteString(w, `{"preview":{"id":"p1","port":3000,"mode":"login","url":"https://abc.outrunner-preview.com/"}}`)
	}))
	defer agent.Close()
	dir := t.TempDir()
	addrFile, tokenFile := filepath.Join(dir, "agent.addr"), filepath.Join(dir, "session.token")
	if err := os.WriteFile(addrFile, []byte(strings.TrimPrefix(agent.URL, "http://")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("session-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := func(string, string) (string, string) { return addrFile, tokenFile }
	var out, errOut bytes.Buffer
	if code := Main(context.Background(), []string{"--root", dir, "--workspace", "a/b", "3000"}, &out, &errOut, paths, nil); code != 0 {
		t.Fatalf("preview = %d: %s", code, errOut.String())
	}
	if rawPath != "/workspaces/a%2Fb/preview" {
		t.Fatalf("the agent was asked at %q, want /workspaces/a%%2Fb/preview", rawPath)
	}
}

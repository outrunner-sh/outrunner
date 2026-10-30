package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDesktopCodexScopedUpload(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	marker := filepath.Join(dir, "home")
	script := "#!/bin/sh\nset -eu\n[ \"$1 $2\" = 'login --device-auth' ]\nprintf '%s' \"$CODEX_HOME\" > '" + marker + "'\n" +
		"printf '%s' '{\"tokens\":{\"access_token\":\"synthetic-access\",\"refresh_token\":\"synthetic-refresh\",\"id_token\":\"synthetic-id\",\"account_id\":\"acct\"}}' > \"$CODEX_HOME/auth.json\"\n" +
		"printf 'https://auth.openai.com/codex/device\\nABCD-EFGHI\\nsynthetic-refresh\\n'\n"
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	uploads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/desktop/codex" || r.Header.Get("Authorization") != "Bearer scoped-ticket" {
			t.Error("unscoped request")
		}
		if r.Method == "PUT" {
			var body struct {
				Tokens map[string]string `json:"tokens"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.Tokens["refresh_token"] != "synthetic-refresh" {
				t.Error("missing upload")
			}
			uploads++
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	reader, writer := io.Pipe()
	defer writer.Close()
	var output bytes.Buffer
	result := make(chan int, 1)
	go func() { result <- DesktopCodexAuth(context.Background(), reader, &output) }()
	_ = json.NewEncoder(writer).Encode(desktopCodexRequest{Endpoint: server.URL + "/api/desktop/codex", Bearer: "scoped-ticket", Binary: binary})
	select {
	case code := <-result:
		if code != 0 {
			t.Fatal("connection failed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connection hung")
	}
	if uploads != 1 || strings.Contains(output.String(), "synthetic-") || strings.Contains(output.String(), "scoped-ticket") {
		t.Fatal("unsafe upload/output")
	}
	home, _ := os.ReadFile(marker)
	if _, err := os.Stat(string(home)); !os.IsNotExist(err) {
		t.Fatal("temporary credentials remain")
	}
}

func TestDesktopCodexClosingInputCancelsLogin(t *testing.T) {
	dir := t.TempDir()
	binary, marker := filepath.Join(dir, "codex"), filepath.Join(dir, "home")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s' \"$CODEX_HOME\" > '"+marker+"'\nexec sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			t.Error("canceled upload")
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	reader, writer := io.Pipe()
	done := make(chan int, 1)
	go func() { done <- DesktopCodexAuth(context.Background(), reader, io.Discard) }()
	_ = json.NewEncoder(writer).Encode(desktopCodexRequest{Endpoint: server.URL + "/api/desktop/codex", Bearer: "ticket", Binary: binary})
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("login never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = writer.Close()
	select {
	case code := <-done:
		if code == 0 {
			t.Fatal("canceled login succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation hung")
	}
	home, _ := os.ReadFile(marker)
	if _, err := os.Stat(string(home)); !os.IsNotExist(err) {
		t.Fatal("canceled credentials remain")
	}
}

func TestDesktopCodexRejectsOtherEndpoints(t *testing.T) {
	for _, raw := range []string{"http://evil.test/api/desktop/codex", "https://app.outrunner.sh/api/cli/codex", "https://app.outrunner.sh/api/desktop/codex?org=other", "https://user:password@app.outrunner.sh/api/desktop/codex"} {
		if validDesktopCodexEndpoint(raw) {
			t.Fatal("accepted", raw)
		}
	}
}

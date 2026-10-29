package codex

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Optional real-native-CLI probe. No provider account/network is involved:
// CODEX_TEST_BINARY=/path/to/codex go test ./internal/codex -run AccountNative
func TestAccountNativeCLIUsesHostManagedBroker(t *testing.T) {
	binary := os.Getenv("CODEX_TEST_BINARY")
	if binary == "" {
		t.Skip("CODEX_TEST_BINARY isn't set")
	}
	var inference atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/runtime/codex/models" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"models":[]}`)
			return
		}
		if r.URL.Path != "/api/runtime/codex/responses" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-outrunner-grant" {
			t.Error("broker grant not used")
		}
		inference.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		events := []string{`{"type":"response.created","response":{"id":"r1"}}`,
			`{"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"broker verified"}]}}`,
			`{"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`}
		for _, event := range events {
			fmt.Fprintf(w, "data: %s\n\n", event)
		}
	}))
	defer server.Close()
	raw, _ := json.Marshal(map[string]string{"url": server.URL + "/api/runtime/codex", "bearer": "synthetic-outrunner-grant"})
	config, auth, err := AccountConfig(base64.RawURLEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	if err = os.WriteFile(filepath.Join(home, "config.toml"), []byte("cli_auth_credentials_store = \"file\"\n"+config), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(home, "auth.json"), []byte(auth), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "gpt-6.1-sol", "Return broker verified.")
	command.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "PATH=" + os.Getenv("PATH")}
	command.Dir = home
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("native Codex fixture failed: %v; output: %s", err, out)
	}
	if inference.Load() != 1 || !strings.Contains(string(out), "broker verified") {
		t.Fatal("native Codex did not finish through broker")
	}
	raw, err = os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"refresh_token":""`) {
		t.Fatal("provider refresh ownership escaped")
	}
}

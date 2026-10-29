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

	// Headless exec alone misses older CLIs' account/read bootstrap failure.
	// Exercise the actual interactive path used by cloud sessions as well.
	t.Run("interactive startup and inference", func(t *testing.T) {
		if _, err := exec.LookPath("tmux"); err != nil {
			t.Skip("tmux isn't installed")
		}
		socket := fmt.Sprintf("outrunner-codex-account-%d", time.Now().UnixNano())
		run := func(args ...string) string {
			t.Helper()
			cmd := exec.CommandContext(ctx, "tmux", append([]string{"-L", socket}, args...)...)
			cmd.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "PATH=" + os.Getenv("PATH")}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("tmux %s: %v: %s", args[0], err, out)
			}
			return string(out)
		}
		run("new-session", "-d", "-s", "fixture", "-x", "120", "-y", "40", "sleep", "60")
		defer exec.Command("tmux", "-L", socket, "kill-server").Run()
		run("set-option", "-g", "remain-on-exit", "on")
		if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("cli_auth_credentials_store = \"file\"\n"+config+"\n[projects."+TOMLString(home)+"]\ntrust_level = \"trusted\"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		run("new-window", "-t", "fixture", "-n", "codex", "-c", home,
			binary, "-m", "gpt-6.1-sol", "-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox")
		launched := time.Now()
		until := launched.Add(20 * time.Second)
		ready := false
		for time.Now().Before(until) && ctx.Err() == nil {
			pane := run("capture-pane", "-p", "-t", "fixture:codex")
			if strings.TrimSpace(run("display-message", "-p", "-t", "fixture:codex", "#{pane_dead}")) == "1" {
				t.Fatalf("native interactive startup exited: %s", pane)
			}
			if time.Since(launched) >= 2*time.Second && strings.Contains(pane, "›") && strings.Contains(pane, "gpt-6.1-sol") && strings.Contains(pane, " · ") && !strings.Contains(pane, "Press enter to") {
				ready = true
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		if !ready {
			t.Fatal("native interactive composer didn't become ready")
		}
		run("set-buffer", "-b", "account-probe", "Return broker verified.")
		run("paste-buffer", "-t", "fixture:codex", "-b", "account-probe", "-d", "-p")
		time.Sleep(300 * time.Millisecond)
		run("send-keys", "-t", "fixture:codex", "Enter")
		lastSubmit := time.Now()
		for time.Now().Before(until) && ctx.Err() == nil {
			pane := run("capture-pane", "-p", "-t", "fixture:codex")
			if inference.Load() > 1 && strings.Contains(pane, "broker verified") {
				return
			}
			if inference.Load() == 1 && time.Since(lastSubmit) >= time.Second {
				run("send-keys", "-t", "fixture:codex", "Enter")
				lastSubmit = time.Now()
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatalf("native interactive inference didn't complete through the broker (requests=%d): %s", inference.Load(), run("capture-pane", "-p", "-t", "fixture:codex"))
	})
}

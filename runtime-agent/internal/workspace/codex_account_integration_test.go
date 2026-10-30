package workspace

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

	"runtime-agent/internal/claude"
	"runtime-agent/internal/testtls"
	"runtime-agent/internal/tmux"
)

// Actual runtime/TUI/rollout probe, using a synthetic local inference server.
// No provider account is read or used. Requires an explicit PRIVATE tmux socket:
// CODEX_TEST_BINARY=/path/to/codex RUNTIME_TMUX_SOCKET=outrunner-codex-test-probe \
// go test ./internal/workspace -run TestCodexAccountNativeSession -v
func TestCodexAccountNativeSession(t *testing.T) {
	binary := os.Getenv("CODEX_TEST_BINARY")
	if binary == "" {
		t.Skip("CODEX_TEST_BINARY isn't set")
	}
	if !strings.HasPrefix(os.Getenv("RUNTIME_TMUX_SOCKET"), "outrunner-codex-test-") {
		t.Fatal("use a private outrunner-codex-test-* tmux socket")
	}
	if _, err := exec.LookPath(tmux.Program()); err != nil {
		t.Fatal("tmux is required for the native session probe")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", filepath.Dir(binary)+string(os.PathListSeparator)+os.Getenv("PATH"))
	var calls atomic.Int32
	var upstream *httptest.Server
	var cert string
	upstream, cert = testtls.NewServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Logf("Broker request: %s %s", r.Method, r.URL.Path)
		if r.URL.Path == "/api/runtime/codex/api/codex/accounts/check" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"accounts":[{"id":"outrunner","workspace_backend_origin":%q,"account_routing_override":"NO_CONSTRAINT"}]}`, upstream.URL)
			return
		}
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
			t.Error("wrong broker authorization")
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, event := range []string{`{"type":"response.created","response":{"id":"r1"}}`,
			`{"type":"response.output_item.done","output_index":0,"item":{"id":"m1","type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"broker verified"}]}}`,
			`{"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`} {
			fmt.Fprintf(w, "data: %s\n\n", event)
		}
	}))
	defer upstream.Close()
	t.Setenv("CODEX_CA_CERTIFICATE", cert)
	t.Setenv("SSL_CERT_FILE", cert)
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()
	s := NewService(t.TempDir())
	s.env = []string{"HOME=" + os.Getenv("HOME"), "PATH=" + os.Getenv("PATH"), "TERM=xterm-256color", "CODEX_CA_CERTIFICATE=" + cert, "SSL_CERT_FILE=" + cert}
	const id = "codex-account-native-probe"
	if _, err := s.Create(ctx, CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir(), Agent: AgentCodex, Model: "gpt-6.1-sol", PermissionMode: claude.Default}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Destroy(context.Background(), id) })
	grant, _ := json.Marshal(map[string]string{"url": upstream.URL + "/api/runtime/codex", "bearer": "synthetic-outrunner-grant"})
	if err := s.SetAuth(ctx, id, AuthCodexAccount, base64.RawURLEncoding.EncodeToString(grant)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, id, ""); err != nil {
		pane, _ := s.tmux.CapturePane(context.Background(), sessionName(id))
		t.Fatalf("Start: %v\n%s", err, pane)
	}
	if pane, _ := s.tmux.CapturePane(ctx, sessionName(id)); !isCodexComposer(pane) {
		t.Fatalf("no Codex composer: %s", pane)
	} else {
		t.Logf("Native Codex composer:\n%s", pane)
	}
	if err := s.SendMessage(id, "Reply with broker verified."); err != nil {
		pane, _ := s.tmux.CapturePane(ctx, sessionName(id))
		t.Fatalf("SendMessage: %v\n%s", err, pane)
	}
	for ctx.Err() == nil {
		if path := s.SessionLog(id); path != "" {
			raw, _ := os.ReadFile(path)
			if strings.Contains(string(raw), "broker verified") && strings.Contains(string(raw), `"role":"assistant"`) {
				// The TUI may also generate a title in a temporary thread.
				// Delivery must record the user's prompt exactly once.
				if calls.Load() == 0 || s.userTurns(id) != 1 {
					t.Fatalf("inference requests: %d", calls.Load())
				}
				pane, _ := s.tmux.CapturePane(ctx, sessionName(id))
				t.Logf("Native Codex reply:\n%s", pane)
				t.Run("resume the recorded conversation", func(t *testing.T) {
					before, _ := s.getFacts(id)
					if before.CodexSessionID == "" {
						t.Fatal("missing native session ID")
					}
					if err := s.Stop(ctx, id); err != nil {
						t.Fatal(err)
					}
					if _, err := s.Resume(ctx, id, ""); err != nil {
						t.Fatal(err)
					}
					if err := s.SendMessage(id, "Reply with broker verified again."); err != nil {
						t.Fatal(err)
					}
					after, _ := s.getFacts(id)
					if after.CodexSessionID != before.CodexSessionID || s.userTurns(id) != 2 {
						t.Fatal("resume lost the native conversation or duplicated a prompt")
					}
				})
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	pane, _ := s.tmux.CapturePane(context.Background(), sessionName(id))
	t.Fatalf("no translated assistant response: %s", pane)
}

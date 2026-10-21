package server

import (
	"bufio"
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

	"runtime-agent/internal/ask"
	"runtime-agent/internal/workspace"
)

// An agent's question goes from its relay through the agent to the browser's
// answer, and the answer back as the tool's result.
func TestAQuestionIsAnsweredFromTheBrowser(t *testing.T) {
	const secret = "test-secret"
	root := t.TempDir()
	svc := workspace.NewService(root)
	ts := httptest.NewServer(New(secret, svc).Handler())
	defer ts.Close()
	if err := svc.Announce(ts.Listener.Addr()); err != nil {
		t.Fatal(err)
	}
	addrFile, tokenFile := workspace.AskPaths(root, "ws-q")
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("session-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	call := controlCall(t, ts.URL, secret)

	// Without the session's token the agent refuses the question.
	req, _ := http.NewRequest("POST", ts.URL+"/workspaces/ws-q/ask", strings.NewReader(`{"requestId":"r","questions":[]}`))
	req.Header.Set("Authorization", "Bearer wrong")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("ask with a wrong token = %v %v, want 401", resp.StatusCode, err)
	}

	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	defer inW.Close()
	go func() {
		_ = ask.Relay(context.Background(), inR, outW, ask.RelayConfig{WorkspaceID: "ws-q", AddrFile: addrFile, TokenFile: tokenFile})
		outW.Close()
	}()
	results := bufio.NewScanner(outR)
	_, _ = io.WriteString(inW, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_user","arguments":{"questions":[{"header":"Storage","question":"Where?","options":[{"label":"DB","description":"Columns"},"Facts"]}]}}}`+"\n")

	// The browser answers the questions as the transcript shows them.
	questions := []map[string]any{{"header": "Storage", "question": "Where?", "options": []any{
		map[string]string{"label": "DB", "description": "Columns"}, map[string]string{"label": "Facts"},
	}}}
	answer := map[string]any{"questions": questions, "answers": []any{map[string]any{"selected": []string{"DB"}}}}
	deadline := time.Now().Add(3 * time.Second)
	for {
		code, out := call("ws-q", "POST", "/workspaces/ws-q/answer", answer)
		if code == http.StatusOK {
			break
		}
		if code != http.StatusConflict || time.Now().After(deadline) {
			t.Fatalf("answer = %d %v", code, out) // 409 until the relay's call arrives
		}
		time.Sleep(5 * time.Millisecond)
	}

	if !results.Scan() {
		t.Fatal("no tool result")
	}
	var msg struct {
		Result struct {
			Content []struct{ Text string }
			IsError bool
		}
	}
	if err := json.Unmarshal(results.Bytes(), &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Result.IsError || !strings.Contains(msg.Result.Content[0].Text, `"Where?" = "DB"`) {
		t.Fatalf("tool result = %+v", msg.Result)
	}
	// Answered: the card's second click finds nothing waiting.
	if code, _ := call("ws-q", "POST", "/workspaces/ws-q/answer", answer); code != http.StatusConflict {
		t.Fatalf("second answer = %d, want 409", code)
	}
}

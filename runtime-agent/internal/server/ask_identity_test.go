package server

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

// The agent names the call it waits on, and an answer naming it is
// delivered once: a retry replays its receipt, an answer naming another
// call is 409 even though its questions match.
func TestAnAnswerNamesTheCallItAnswers(t *testing.T) {
	const secret = "test-secret"
	root := t.TempDir()
	svc := workspace.NewService(root)
	ts := httptest.NewServer(New(secret, svc).Handler())
	defer ts.Close()
	if err := svc.Announce(ts.Listener.Addr()); err != nil {
		t.Fatal(err)
	}
	addrFile, tokenFile := workspace.AskPaths(root, "ws-i")
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("session-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	call := controlCall(t, ts.URL, secret)

	code, health := call("ws-i", "GET", "/health", nil)
	features, _ := health["features"].([]any)
	if code != http.StatusOK || !slices.Contains(features, any(protocol.FeatureAskCallIdentity)) {
		t.Fatalf("health = %d %v, want %s", code, health, protocol.FeatureAskCallIdentity)
	}
	if code, out := call("ws-i", "GET", "/workspaces/ws-i/question", nil); code != http.StatusOK || len(out["questions"].([]any)) != 0 {
		t.Fatalf("nothing waiting: %d %v", code, out)
	}

	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	defer inW.Close()
	go func() {
		_ = ask.Relay(context.Background(), inR, outW, ask.RelayConfig{WorkspaceID: "ws-i", AddrFile: addrFile, TokenFile: tokenFile})
		outW.Close()
	}()
	results := bufio.NewScanner(outR)
	const toolCall = `{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"ask_user","_meta":{"claudecode/toolUseId":"toolu_%d"},"arguments":{"questions":[{"question":"Where?","options":["DB","Facts"]}]}}}` + "\n"
	ask1 := pendingCall(t, call, inW, strings.Replace(strings.Replace(toolCall, "%d", "1", 1), "%d", "1", 1))
	if ask1["chat"] != "main" || ask1["workspaceId"] != "ws-i" || ask1["launchEpoch"] == "" {
		t.Fatalf("pending = %v", ask1)
	}
	if _, ok := ask1["toolUseId"]; ok {
		t.Fatalf("toolUseId with no transcript to verify it: %v", ask1)
	}
	answer := func(id map[string]any, op, label string) (int, map[string]any) {
		return call("ws-i", "POST", "/workspaces/ws-i/answer", map[string]any{
			"callId": id["callId"], "launchEpoch": id["launchEpoch"], "answerOperationId": op,
			"answers": []any{map[string]any{"selected": []string{label}}},
		})
	}
	if code, out := answer(ask1, "op1", "DB"); code != http.StatusOK || out["result"] != "answered" || out["replayed"] != nil {
		t.Fatalf("answer = %d %v", code, out)
	}
	if !results.Scan() || !strings.Contains(results.Text(), `\"Where?\" = \"DB\"`) {
		t.Fatalf("tool result = %s", results.Text())
	}
	if code, out := answer(ask1, "op1", "DB"); code != http.StatusOK || out["replayed"] != true {
		t.Fatalf("retry = %d %v, want replayed", code, out)
	}

	// The same question asked again is another call: the first's identity
	// doesn't answer it.
	ask2 := pendingCall(t, call, inW, strings.Replace(strings.Replace(toolCall, "%d", "2", 1), "%d", "2", 1))
	if ask2["callId"] == ask1["callId"] || ask2["launchEpoch"] != ask1["launchEpoch"] {
		t.Fatalf("second call = %v, first %v", ask2, ask1)
	}
	if code, out := answer(ask1, "op2", "Facts"); code != http.StatusConflict || !strings.Contains(out["error"].(map[string]any)["message"].(string), ask.ErrNotWaiting.Error()) {
		t.Fatalf("stale answer = %d %v, want 409", code, out)
	}
	if code, _ := answer(map[string]any{"callId": ask2["callId"], "launchEpoch": "old"}, "op3", "Facts"); code != http.StatusConflict {
		t.Fatalf("old epoch = %d, want 409", code)
	}
	if code, _ := answer(ask2, "op1", "Facts"); code != http.StatusConflict {
		t.Fatalf("reused operation = %d, want 409", code)
	}
	if code, _ := call("ws-i", "POST", "/workspaces/ws-i/answer", map[string]any{"callId": ask2["callId"], "answers": []any{}}); code != http.StatusBadRequest {
		t.Fatalf("partial identity = %d, want 400", code)
	}
	// An old client, naming no call, answers by text as before.
	legacy := map[string]any{"questions": []any{map[string]any{"question": "Where?", "options": []any{map[string]string{"label": "DB"}, map[string]string{"label": "Facts"}}}}, "answers": []any{map[string]any{"selected": []string{"Facts"}}}}
	if code, out := call("ws-i", "POST", "/workspaces/ws-i/answer", legacy); code != http.StatusOK {
		t.Fatalf("legacy answer = %d %v", code, out)
	}
	if !results.Scan() || !strings.Contains(results.Text(), `\"Where?\" = \"Facts\"`) {
		t.Fatalf("tool result = %s", results.Text())
	}
}

// pendingCall sends a tool call to the relay and waits for the agent to
// list it, returning the listing.
func pendingCall(t *testing.T, call controlCaller, in io.Writer, line string) map[string]any {
	t.Helper()
	_, _ = io.WriteString(in, line)
	deadline := time.Now().Add(3 * time.Second)
	for {
		code, out := call("ws-i", "GET", "/workspaces/ws-i/question", nil)
		if qs, _ := out["questions"].([]any); code == http.StatusOK && len(qs) == 1 {
			return qs[0].(map[string]any)
		}
		if time.Now().After(deadline) {
			t.Fatalf("question never listed: %d %v", code, out)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

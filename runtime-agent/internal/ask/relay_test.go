package ask

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
)

type testRelay struct {
	t      *testing.T
	in     *io.PipeWriter
	out    *bufio.Scanner
	lines  chan string
	done   chan error
	config RelayConfig
}

// startRelay runs a relay for workspace "ws" whose agent is at the server's
// address, with the session token "tok".
func startRelay(t *testing.T, server *httptest.Server, retryFor time.Duration) *testRelay {
	t.Helper()
	dir := t.TempDir()
	cfg := RelayConfig{
		WorkspaceID: "ws",
		AddrFile:    filepath.Join(dir, "agent.addr"),
		TokenFile:   filepath.Join(dir, "ws.token"),
		RetryFor:    retryFor,
		RetryEvery:  5 * time.Millisecond,
	}
	writeAddr(t, cfg.AddrFile, server)
	if err := os.WriteFile(cfg.TokenFile, []byte("tok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	r := &testRelay{t: t, in: inW, lines: make(chan string, 16), done: make(chan error, 1), config: cfg}
	go func() {
		r.done <- Relay(context.Background(), inR, outW, cfg)
		outW.Close()
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		for scanner.Scan() {
			r.lines <- scanner.Text()
		}
		close(r.lines)
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

func writeAddr(t *testing.T, path string, server *httptest.Server) {
	t.Helper()
	addr := strings.TrimPrefix(server.URL, "http://")
	if err := os.WriteFile(path, []byte(addr+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (r *testRelay) send(msg string) {
	r.t.Helper()
	if _, err := io.WriteString(r.in, msg+"\n"); err != nil {
		r.t.Fatal(err)
	}
}

// next is the relay's next message, decoded.
func (r *testRelay) next() map[string]any {
	r.t.Helper()
	select {
	case line, ok := <-r.lines:
		if !ok {
			r.t.Fatal("relay closed its output")
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			r.t.Fatalf("relay wrote %q: %v", line, err)
		}
		return m
	case <-time.After(3 * time.Second):
		r.t.Fatal("no message from the relay")
	}
	return nil
}

// toolText is a tools/call result's text and whether it is an error.
func toolText(t *testing.T, msg map[string]any) (string, bool) {
	t.Helper()
	result, ok := msg["result"].(map[string]any)
	if !ok {
		t.Fatalf("not a result: %v", msg)
	}
	content := result["content"].([]any)[0].(map[string]any)
	return content["text"].(string), result["isError"] == true
}

const callAsk = `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ask_user","arguments":{"questions":[{"question":"Q?","options":[{"label":"A"},{"label":"B"}]}]}}}`

func TestRelayServesTheToolAndForwardsCalls(t *testing.T) {
	var got struct {
		RequestID string          `json:"requestId"`
		Questions json.RawMessage `json:"questions"`
	}
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/workspaces/ws/ask" || r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("call to %s with %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = io.WriteString(w, `{"text":"The user answered: A"}`)
	}))
	defer agent.Close()
	r := startRelay(t, agent, 0)

	r.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"2"}}}`)
	init := r.next()["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion = %v, want the client's", init["protocolVersion"])
	}
	r.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	r.send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := r.next()["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != ToolName {
		t.Fatalf("tools = %v", tools)
	}

	r.send(callAsk)
	msg := r.next()
	if msg["id"] != float64(7) {
		t.Fatalf("answered id %v, want 7", msg["id"])
	}
	if text, failed := toolText(t, msg); failed || text != "The user answered: A" {
		t.Fatalf("tool result = %q (error %v)", text, failed)
	}
	if got.RequestID == "" || !strings.Contains(string(got.Questions), `"Q?"`) {
		t.Fatalf("agent got %+v", got)
	}

	r.send(`{"jsonrpc":"2.0","id":3,"method":"resources/list"}`)
	if e, ok := r.next()["error"].(map[string]any); !ok || e["code"] != float64(-32601) {
		t.Fatal("unknown method should be method-not-found")
	}
}

// A desktop relaunch starts a new agent on a new port while the session's
// relay carries on: a call cut off by it is asked again of the new agent,
// under the same request id.
func TestRelayAsksTheRestartedAgentAgain(t *testing.T) {
	var firstID, secondID string
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ RequestID string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		secondID = req.RequestID
		_, _ = io.WriteString(w, `{"text":"answered after the restart"}`)
	}))
	defer second.Close()
	var relay *testRelay
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ RequestID string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		firstID = req.RequestID
		// The agent goes away mid-call, and its successor announces itself.
		writeAddr(t, relay.config.AddrFile, second)
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	}))
	defer first.Close()
	relay = startRelay(t, first, 0)

	relay.send(callAsk)
	if text, failed := toolText(t, relay.next()); failed || text != "answered after the restart" {
		t.Fatalf("tool result = %q (error %v)", text, failed)
	}
	if firstID == "" || firstID != secondID {
		t.Fatalf("request ids %q then %q, want the same", firstID, secondID)
	}
}

func TestRelayPassesARefusalToTheAgent(t *testing.T) {
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"code":"INVALID_REQUEST","message":"invalid: question 1 needs 2 to 4 options"}}`)
	}))
	defer agent.Close()
	r := startRelay(t, agent, 0)
	r.send(callAsk)
	if text, failed := toolText(t, r.next()); !failed || !strings.Contains(text, "needs 2 to 4 options") {
		t.Fatalf("tool result = %q (error %v), want the refusal as an error", text, failed)
	}
}

func TestRelayCancelsTheCallTheCLIGaveUp(t *testing.T) {
	asked, gaveUp := make(chan struct{}), make(chan struct{})
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(asked)
		<-r.Context().Done() // waits for an answer that never comes
		close(gaveUp)
	}))
	defer agent.Close()
	r := startRelay(t, agent, 0)
	r.send(callAsk)
	<-asked
	r.send(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"interrupted"}}`)
	select {
	case <-gaveUp:
	case <-time.After(3 * time.Second):
		t.Fatal("the agent's call wasn't given up")
	}
	// A cancelled call gets no response: the next message answers the ping.
	r.send(`{"jsonrpc":"2.0","id":9,"method":"ping"}`)
	if msg := r.next(); msg["id"] != float64(9) {
		t.Fatalf("got %v, want the ping's response", msg)
	}
}

func TestRelayGivesUpOnAnAgentThatNeverComesBack(t *testing.T) {
	agent := httptest.NewServer(http.NotFoundHandler())
	agent.Close() // nothing listens at its address any more
	r := startRelay(t, agent, 30*time.Millisecond)
	r.send(callAsk)
	if text, failed := toolText(t, r.next()); !failed || !strings.Contains(text, "plain text") {
		t.Fatalf("tool result = %q (error %v)", text, failed)
	}
}

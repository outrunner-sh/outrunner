package codex

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"runtime-agent/internal/codex/codextest"
)

func TestMain(m *testing.M) {
	codextest.Main()
	os.Exit(m.Run())
}

// fakeServer starts this test binary as a stand-in app server.
func fakeServer(t *testing.T, h Handlers) *Client {
	t.Helper()
	c, err := Start(os.Args[0], t.TempDir(), codextest.Env(), h)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Initialize(ctx, "outrunner-test", "0.0.0"); err != nil {
		t.Fatal(err)
	}
	return c
}

// items collects item/completed notifications until a turn completes.
type items struct {
	mu   sync.Mutex
	got  []json.RawMessage
	done chan json.RawMessage
}

func newItems() *items { return &items{done: make(chan json.RawMessage, 4)} }

func (it *items) handle(method string, params json.RawMessage) {
	var p struct {
		Item json.RawMessage `json:"item"`
		Turn json.RawMessage `json:"turn"`
	}
	_ = json.Unmarshal(params, &p)
	switch method {
	case "item/completed":
		it.mu.Lock()
		it.got = append(it.got, p.Item)
		it.mu.Unlock()
	case "turn/completed":
		it.done <- p.Turn
	}
}

func (it *items) wait(t *testing.T) json.RawMessage {
	t.Helper()
	select {
	case turn := <-it.done:
		return turn
	case <-time.After(10 * time.Second):
		t.Fatal("no turn/completed")
		return nil
	}
}

func TestAThreadTakesATurnAndStreamsItsItems(t *testing.T) {
	it := newItems()
	c := fakeServer(t, Handlers{Notification: it.handle})
	ctx := context.Background()

	model, err := c.DefaultModel(ctx)
	if err != nil || model != "fake-default" {
		t.Fatalf("DefaultModel = %q, %v", model, err)
	}
	thread, got, err := c.StartThread(ctx, ThreadOptions{Cwd: "/w", Model: model, ApprovalPolicy: "never", Sandbox: "workspace-write"})
	if err != nil || thread == "" || got != "fake-default" {
		t.Fatalf("StartThread = %q, %q, %v", thread, got, err)
	}
	if _, err := c.StartTurn(ctx, thread, "hello", ""); err != nil {
		t.Fatal(err)
	}
	it.wait(t)
	var types []string
	for _, raw := range it.got {
		var h struct{ Type string }
		_ = json.Unmarshal(raw, &h)
		types = append(types, h.Type)
	}
	if strings.Join(types, ",") != "userMessage,commandExecution,agentMessage" {
		t.Errorf("items = %v", types)
	}

	// Resuming keeps the thread's id.
	again, _, err := c.ResumeThread(ctx, thread, ThreadOptions{Cwd: "/w", ApprovalPolicy: "never", Sandbox: "workspace-write"})
	if err != nil || again != thread {
		t.Errorf("ResumeThread = %q, %v; want %q", again, err, thread)
	}
}

func TestRequestsFromTheServerAreAnswered(t *testing.T) {
	it := newItems()
	asked := make(chan string, 1)
	c := fakeServer(t, Handlers{
		Notification: it.handle,
		Request: func(method string, params json.RawMessage) (any, *RPCError) {
			asked <- method
			return map[string]string{"decision": "decline"}, nil
		},
	})
	ctx := context.Background()
	thread, _, err := c.StartThread(ctx, ThreadOptions{Cwd: "/w", ApprovalPolicy: "never", Sandbox: "workspace-write"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.StartTurn(ctx, thread, "ASK first", ""); err != nil {
		t.Fatal(err)
	}
	it.wait(t)
	if method := <-asked; method != "item/commandExecution/requestApproval" {
		t.Errorf("asked %q", method)
	}
	last := it.got[len(it.got)-1]
	if !strings.Contains(string(last), `approval={\"decision\":\"decline\"}`) {
		t.Errorf("the server didn't get the answer: %s", last)
	}
}

func TestCallsFailOnceTheServerIsGone(t *testing.T) {
	c := fakeServer(t, Handlers{})
	c.Close()
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done never closed")
	}
	if _, err := c.Models(context.Background()); err == nil {
		t.Error("a call on an exited server succeeded")
	}
}

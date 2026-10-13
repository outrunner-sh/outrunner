// Package codex drives OpenAI's Codex CLI headless, through its app server
// (`codex app-server --listen stdio://`): newline-delimited JSON-RPC 2.0 over
// the child's stdin and stdout, as Conductor drives it. A thread is one
// conversation (thread/start, thread/resume), a turn one prompt (turn/start),
// and Codex streams what happens as item notifications. No terminal UI is
// involved, so there is nothing to scrape: no first-run screens, no trust
// dialog, no prompt box to find.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Message is one JSON-RPC line from the app server: a response (ID, Result or
// Error), a notification (Method, Params) or a request of its own (all three).
type Message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// RPCError is a JSON-RPC error, either way.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("codex: %s (%d)", e.Message, e.Code) }

// MethodNotFound answers a server request the client doesn't handle.
var MethodNotFound = &RPCError{Code: -32601, Message: "method not supported by Outrunner"}

// Handlers receive what the server sends unasked.
type Handlers struct {
	// Notification is called for each notification, in order, from one
	// goroutine; it must not block for long.
	Notification func(method string, params json.RawMessage)
	// Request answers a request from the server (an approval, a login token
	// refresh). Each runs on its own goroutine. Nil answers MethodNotFound.
	Request func(method string, params json.RawMessage) (any, *RPCError)
}

// Client is one running app server. It is safe for concurrent use.
type Client struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	handlers Handlers

	writeMu sync.Mutex

	mu      sync.Mutex // guards nextID, pending, err
	nextID  int64
	pending map[int64]chan Message
	err     error

	done chan struct{} // closed once the server's output ends
}

// Start runs `bin app-server --listen stdio://` in dir with env, and reads
// its output until it exits. The server and every command it runs share a
// process group of their own, so Close stops all of them.
func Start(bin, dir string, env []string, h Handlers) (*Client, error) {
	cmd := exec.Command(bin, "app-server", "--listen", "stdio://")
	cmd.Dir = dir
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex: %w", err)
	}
	c := &Client{cmd: cmd, stdin: stdin, handlers: h, pending: map[int64]chan Message{}, done: make(chan struct{})}
	go c.read(stdout)
	return c, nil
}

// ErrClosed is a call on a server that has exited.
var ErrClosed = errors.New("codex app server exited")

func (c *Client) read(stdout io.Reader) {
	r := bufio.NewReaderSize(stdout, 1<<20)
	for {
		// A line can be large (a command's whole output, a diff), so no
		// Scanner and its token limit.
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			c.dispatch(line)
		}
		if err != nil {
			break
		}
	}
	c.mu.Lock()
	if c.err == nil {
		c.err = ErrClosed
	}
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	close(c.done)
	_ = c.cmd.Wait()
}

func (c *Client) dispatch(line []byte) {
	var m Message
	if json.Unmarshal(line, &m) != nil {
		return // not JSON-RPC: a stray log line
	}
	switch {
	case m.Method != "" && len(m.ID) > 0:
		go c.answer(m)
	case m.Method != "":
		if c.handlers.Notification != nil {
			c.handlers.Notification(m.Method, m.Params)
		}
	case len(m.ID) > 0:
		var id int64
		if json.Unmarshal(m.ID, &id) != nil {
			return
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}

func (c *Client) answer(m Message) {
	var result any
	rpcErr := MethodNotFound
	if c.handlers.Request != nil {
		result, rpcErr = c.handlers.Request(m.Method, m.Params)
	}
	reply := map[string]any{"jsonrpc": "2.0", "id": m.ID}
	if rpcErr != nil {
		reply["error"] = rpcErr
	} else {
		reply["result"] = result
	}
	_ = c.write(reply)
}

func (c *Client) write(v any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.stdin.Write(append(line, '\n')); err != nil {
		return ErrClosed
	}
	return nil
}

// Call sends a request and decodes its result into result (nil discards it).
func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return c.err
	}
	c.nextID++
	id := c.nextID
	ch := make(chan Message, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		forget()
		return err
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return ErrClosed
		}
		if m.Error != nil {
			return m.Error
		}
		if result == nil || len(m.Result) == 0 {
			return nil
		}
		return json.Unmarshal(m.Result, result)
	case <-ctx.Done():
		forget()
		return ctx.Err()
	}
}

// Notify sends a notification (no reply).
func (c *Client) Notify(method string, params any) error {
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		msg["params"] = params
	}
	return c.write(msg)
}

// Done is closed once the server has exited.
func (c *Client) Done() <-chan struct{} { return c.done }

// Close stops the server and every command it started: SIGTERM to the whole
// process group, SIGKILL if it is still there a few seconds on.
func (c *Client) Close() {
	_ = c.stdin.Close()
	if c.cmd.Process == nil {
		return
	}
	pgid := -c.cmd.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		_ = syscall.Kill(pgid, syscall.SIGKILL)
		<-c.done
	}
}

// Initialize performs the handshake every connection starts with.
func (c *Client) Initialize(ctx context.Context, name, version string) error {
	params := map[string]any{
		"clientInfo":   map[string]any{"name": name, "title": "Outrunner", "version": version},
		"capabilities": nil,
	}
	if err := c.Call(ctx, "initialize", params, nil); err != nil {
		return fmt.Errorf("codex initialize: %w", err)
	}
	return c.Notify("initialized", nil)
}

// ThreadOptions configure a conversation.
type ThreadOptions struct {
	Cwd   string
	Model string
	// ApprovalPolicy is when Codex asks before acting ("never", "on-request").
	ApprovalPolicy string
	// Sandbox is what its commands may touch ("workspace-write": the working
	// directory only, no network).
	Sandbox string
	// DeveloperInstructions are added to Codex's own, as Claude's
	// --append-system-prompt is.
	DeveloperInstructions string
}

func (o ThreadOptions) params() map[string]any {
	p := map[string]any{"cwd": o.Cwd, "approvalPolicy": o.ApprovalPolicy, "sandbox": o.Sandbox}
	if o.Model != "" {
		p["model"] = o.Model
	}
	if o.DeveloperInstructions != "" {
		p["developerInstructions"] = o.DeveloperInstructions
	}
	return p
}

type threadResult struct {
	Thread struct {
		ID string `json:"id"`
	} `json:"thread"`
	Model string `json:"model"`
}

// StartThread begins a conversation, which Codex keeps on disk so it can be
// resumed. It returns the thread's id and the model it runs.
func (c *Client) StartThread(ctx context.Context, o ThreadOptions) (id, model string, err error) {
	var r threadResult
	if err := c.Call(ctx, "thread/start", o.params(), &r); err != nil {
		return "", "", err
	}
	return r.Thread.ID, r.Model, nil
}

// ResumeThread continues a conversation started before, with these options.
func (c *Client) ResumeThread(ctx context.Context, threadID string, o ThreadOptions) (id, model string, err error) {
	p := o.params()
	p["threadId"] = threadID
	var r threadResult
	if err := c.Call(ctx, "thread/resume", p, &r); err != nil {
		return "", "", err
	}
	return r.Thread.ID, r.Model, nil
}

// StartTurn sends a prompt. model, when set, is used from this turn on.
func (c *Client) StartTurn(ctx context.Context, threadID, text, model string) (turnID string, err error) {
	p := map[string]any{
		"threadId": threadID,
		"input":    []any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}},
	}
	if model != "" {
		p["model"] = model
	}
	var r struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.Call(ctx, "turn/start", p, &r); err != nil {
		return "", err
	}
	return r.Turn.ID, nil
}

// Model is one model the signed-in account may use.
type Model struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	IsDefault   bool   `json:"isDefault"`
	Hidden      bool   `json:"hidden"`
}

// Models lists the models the account may use, as Codex itself knows them:
// they change from one Codex release to the next.
func (c *Client) Models(ctx context.Context) ([]Model, error) {
	var r struct {
		Data []Model `json:"data"`
	}
	if err := c.Call(ctx, "model/list", map[string]any{}, &r); err != nil {
		return nil, err
	}
	return r.Data, nil
}

// DefaultModel is the account's default model, or the first one listed. The
// user's own config.toml default may be one their login can't use.
func (c *Client) DefaultModel(ctx context.Context) (string, error) {
	models, err := c.Models(ctx)
	if err != nil {
		return "", err
	}
	for _, m := range models {
		if m.IsDefault {
			return m.ID, nil
		}
	}
	for _, m := range models {
		if !m.Hidden {
			return m.ID, nil
		}
	}
	return "", errors.New("codex lists no models for this login")
}

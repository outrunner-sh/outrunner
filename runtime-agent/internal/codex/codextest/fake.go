// Package codextest is a stand-in for `codex app-server`, for tests: a test
// binary re-runs itself as the server (see Main), so the client and the
// workspace engine are tested over real pipes without Codex installed.
package codextest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
)

// EnvVar makes a test binary act as the app server instead of running tests.
const EnvVar = "OUTRUNNER_FAKE_CODEX_APP_SERVER"

// Main serves as the app server when the test binary was started as one. Call
// it first thing in TestMain.
func Main() {
	if os.Getenv(EnvVar) != "1" {
		return
	}
	Serve(os.Stdin, os.Stdout)
	os.Exit(0)
}

// Env is what a test passes to start the fake: the test binary, run as the
// app server.
func Env() []string { return append(os.Environ(), EnvVar+"=1") }

// Serve answers like Codex 0.162 does, closely enough for Outrunner:
//   - model/list offers "fake-default" (the default) and "fake-other";
//   - a turn whose prompt contains "FAIL" fails with an API error in JSON;
//   - any other turn reports the prompt, a command `ls`, and a reply
//     "echo: <prompt> (<model>)", then completes;
//   - a turn whose prompt contains "ASK" first asks the client to approve a
//     command and puts its answer in the reply.
func Serve(in io.Reader, out io.Writer) {
	var mu sync.Mutex
	send := func(v any) {
		line, _ := json.Marshal(v)
		mu.Lock()
		defer mu.Unlock()
		_, _ = out.Write(append(line, '\n'))
	}
	notify := func(method string, params any) {
		send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	}
	answers := map[string]chan json.RawMessage{}
	var answersMu sync.Mutex
	threadModel := map[string]string{}
	threads, turns := 0, 0

	r := bufio.NewReader(in)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		if m.Method == "" && len(m.ID) > 0 { // the client answering our request
			answersMu.Lock()
			ch := answers[string(m.ID)]
			answersMu.Unlock()
			if ch != nil {
				ch <- m.Result
			}
			continue
		}
		reply := func(result any) { send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result}) }
		var p map[string]any
		_ = json.Unmarshal(m.Params, &p)
		switch m.Method {
		case "initialize":
			reply(map[string]any{"userAgent": "fake-codex/0.0.0"})
		case "model/list":
			reply(map[string]any{"data": []any{
				map[string]any{"id": "fake-default", "displayName": "Fake Default", "isDefault": true},
				map[string]any{"id": "fake-other", "displayName": "Fake Other"},
			}})
		case "thread/start", "thread/resume":
			id, _ := p["threadId"].(string)
			if id == "" {
				threads++
				id = fmt.Sprintf("thread-%d", threads)
			}
			model, _ := p["model"].(string)
			if model == "" {
				model = "fake-config-default"
			}
			threadModel[id] = model
			reply(map[string]any{"thread": map[string]any{"id": id}, "model": model, "resumed": m.Method == "thread/resume"})
		case "turn/start":
			turns++
			thread, _ := p["threadId"].(string)
			if model, _ := p["model"].(string); model != "" {
				threadModel[thread] = model
			}
			turn := fmt.Sprintf("turn-%d", turns)
			text := ""
			if input, _ := p["input"].([]any); len(input) > 0 {
				first, _ := input[0].(map[string]any)
				text, _ = first["text"].(string)
			}
			reply(map[string]any{"turn": map[string]any{"id": turn, "status": "inProgress"}})
			go func(thread, turn, text, model string, n int) {
				notify("turn/started", map[string]any{"threadId": thread, "turn": map[string]any{"id": turn}})
				item := func(v map[string]any) {
					notify("item/completed", map[string]any{"threadId": thread, "turnId": turn, "item": v})
				}
				item(map[string]any{"type": "userMessage", "id": fmt.Sprintf("user-%d", n), "content": []any{map[string]any{"type": "text", "text": text}}})
				if strings.Contains(text, "FAIL") {
					msg := `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'x' model is not supported."}}`
					notify("turn/completed", map[string]any{"threadId": thread, "turn": map[string]any{"id": turn, "status": "failed", "error": map[string]any{"message": msg}}})
					return
				}
				reply := fmt.Sprintf("echo: %s (%s)", text, model)
				if strings.Contains(text, "ASK") {
					id := fmt.Sprintf(`"ask-%d"`, n)
					ch := make(chan json.RawMessage, 1)
					answersMu.Lock()
					answers[id] = ch
					answersMu.Unlock()
					send(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": "item/commandExecution/requestApproval", "params": map[string]any{"threadId": thread, "turnId": turn, "command": "rm -rf /"}})
					reply += " approval=" + string(<-ch)
				}
				item(map[string]any{"type": "commandExecution", "id": fmt.Sprintf("exec-%d", n), "command": "/bin/bash -lc 'ls'", "aggregatedOutput": "a.txt\n", "exitCode": 0, "status": "completed"})
				item(map[string]any{"type": "agentMessage", "id": fmt.Sprintf("msg-%d", n), "text": reply})
				notify("turn/completed", map[string]any{"threadId": thread, "turn": map[string]any{"id": turn, "status": "completed"}})
			}(thread, turn, text, threadModel[thread], turns)
		default:
			if len(m.ID) > 0 {
				reply(map[string]any{})
			}
		}
	}
}

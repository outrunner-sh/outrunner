package codex

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
)

var at = time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)

// decode reads Records' output back the way the conversation watcher does.
func decode(t *testing.T, lines [][]byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range lines {
		if !strings.HasSuffix(string(line), "\n") {
			t.Fatalf("not a JSONL line: %q", line)
		}
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func content(rec map[string]any) []any {
	c, _ := rec["message"].(map[string]any)["content"].([]any)
	return c
}

func TestItemsBecomeTheChatsRecords(t *testing.T) {
	// Items as Codex 0.162 sends them (trimmed).
	cases := []struct {
		name, item string
		check      func(t *testing.T, recs []map[string]any)
	}{
		{"the user's prompt", `{"type":"userMessage","id":"u1","content":[{"type":"text","text":"Run ls","text_elements":[]}]}`,
			func(t *testing.T, recs []map[string]any) {
				msg := recs[0]["message"].(map[string]any)
				if recs[0]["type"] != "user" || msg["content"] != "Run ls" {
					t.Errorf("%v", recs[0])
				}
			}},
		{"a reply", `{"type":"agentMessage","id":"m1","text":"CODEX-OK","phase":null}`,
			func(t *testing.T, recs []map[string]any) {
				msg := recs[0]["message"].(map[string]any)
				block := content(recs[0])[0].(map[string]any)
				if msg["model"] != "gpt-6-luna" || block["type"] != "text" || block["text"] != "CODEX-OK" {
					t.Errorf("%v", recs[0])
				}
			}},
		{"a command, by what the model wrote", `{"type":"commandExecution","id":"e1","command":"/bin/bash -lc 'ls -a'","aggregatedOutput":".\n..\n","exitCode":0,"status":"completed"}`,
			func(t *testing.T, recs []map[string]any) {
				use, result := content(recs[0])[0].(map[string]any), content(recs[0])[1].(map[string]any)
				if use["name"] != "Bash" || use["input"].(map[string]any)["command"] != "ls -a" {
					t.Errorf("tool_use %v", use)
				}
				if result["toolUseId"] != "e1" || result["content"] != ".\n..\n" {
					t.Errorf("tool_result %v", result)
				}
			}},
		{"a failed command says its exit code", `{"type":"commandExecution","id":"e2","command":"false","aggregatedOutput":"","exitCode":1,"status":"failed"}`,
			func(t *testing.T, recs []map[string]any) {
				if r := content(recs[0])[1].(map[string]any)["content"]; !strings.Contains(r.(string), "exit code 1") {
					t.Errorf("result %v", r)
				}
			}},
		{"file changes, by path", `{"type":"fileChange","id":"f1","changes":[{"path":"/w/new.txt","kind":{"type":"add"},"diff":"+hi"},{"path":"/w/a.txt","kind":{"type":"update","move_path":null},"diff":"-a\n+b"}],"status":"completed"}`,
			func(t *testing.T, recs []map[string]any) {
				blocks := content(recs[0])
				if len(blocks) != 4 || blocks[0].(map[string]any)["name"] != "Write" || blocks[2].(map[string]any)["name"] != "Edit" {
					t.Fatalf("%v", blocks)
				}
				if blocks[2].(map[string]any)["input"].(map[string]any)["file_path"] != "/w/a.txt" {
					t.Errorf("%v", blocks[2])
				}
			}},
		{"reasoning's summary", `{"type":"reasoning","id":"r1","summary":["Checking files"],"content":[]}`,
			func(t *testing.T, recs []map[string]any) {
				if b := content(recs[0])[0].(map[string]any); b["type"] != "thinking" || b["text"] != "Checking files" {
					t.Errorf("%v", b)
				}
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lines := Records(json.RawMessage(c.item), "gpt-6-luna", at)
			if len(lines) != 1 {
				t.Fatalf("got %d lines", len(lines))
			}
			c.check(t, decode(t, lines))
		})
	}
}

func TestNothingToShowWritesNothing(t *testing.T) {
	for _, item := range []string{
		`{"type":"agentMessage","id":"m0","text":""}`, // started, not yet written
		`{"type":"reasoning","id":"r0","summary":[],"content":[]}`,
		`{"type":"contextCompaction","id":"c0"}`,
		`not json`,
	} {
		if lines := Records(json.RawMessage(item), "", at); lines != nil {
			t.Errorf("%s: %q", item, lines)
		}
	}
}

func TestTheWatcherReadsTheRecords(t *testing.T) {
	// What the chat actually receives: through the same decoder as Claude's.
	dir := t.TempDir()
	path := dir + "/c.jsonl"
	var all []byte
	for _, item := range []string{
		`{"type":"userMessage","id":"u1","content":[{"type":"text","text":"hi"}]}`,
		`{"type":"commandExecution","id":"e1","command":"/bin/bash -lc 'ls'","aggregatedOutput":"a\n","exitCode":0,"status":"completed"}`,
		`{"type":"agentMessage","id":"m1","text":"done"}`,
	} {
		for _, line := range Records(json.RawMessage(item), "gpt-6-luna", at) {
			all = append(all, line...)
		}
	}
	all = append(all, ErrorRecord("turn-1-error", `{"error":{"message":"The 'x' model is not supported."}}`, at)...)
	events := watch(t, path, all, 4)
	if len(events) != 4 {
		t.Fatalf("watcher saw %d messages, want 4", len(events))
	}
	if events[0].Role != "user" || events[0].Content[0].Text != "hi" {
		t.Errorf("prompt: %+v", events[0])
	}
	if events[1].Content[0].Name != "Bash" || events[1].Content[1].ToolUseID != "e1" {
		t.Errorf("command: %+v", events[1].Content)
	}
	if events[2].Model != "gpt-6-luna" || events[2].Content[0].Text != "done" {
		t.Errorf("reply: %+v", events[2])
	}
	if events[3].Content[0].Text != "Codex stopped: The 'x' model is not supported." {
		t.Errorf("error: %+v", events[3].Content)
	}
}

// watch writes data to path and returns the first n messages the conversation
// watcher reads from it.
func watch(t *testing.T, path string, data []byte, n int) []*protocol.ConversationMessage {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w := conversation.New(func() string { return path }, 0)
	w.SetInterval(10 * time.Millisecond)
	out := make(chan conversation.Event, 16)
	go w.Run(ctx, out)
	var got []*protocol.ConversationMessage
	for len(got) < n {
		select {
		case ev := <-out:
			if ev.Message != nil {
				got = append(got, ev.Message)
			}
		case <-ctx.Done():
			return got
		}
	}
	return got
}

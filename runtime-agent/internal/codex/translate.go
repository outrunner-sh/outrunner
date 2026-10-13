package codex

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

// Records renders one completed Codex item as the Claude-shaped JSONL lines
// Outrunner's conversation watcher already tails (the shape the jcode engine
// writes too), so the session's chat, summary and replay need nothing of
// their own for Codex. Tools take the names the chat knows: a command is Bash
// (shown by its command), a new file Write and a changed one Edit (by path).
// Items with nothing to show render as no lines.
func Records(item json.RawMessage, model string, at time.Time) [][]byte {
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(item, &head) != nil || head.ID == "" {
		return nil
	}
	ts := at.UTC().Format(time.RFC3339Nano)
	switch head.Type {
	case "userMessage":
		var it struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		_ = json.Unmarshal(item, &it)
		var parts []string
		for _, c := range it.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		if len(parts) == 0 {
			return nil
		}
		return lines(userRecord(head.ID, ts, strings.Join(parts, "\n")))
	case "agentMessage":
		var it struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(item, &it)
		if strings.TrimSpace(it.Text) == "" {
			return nil
		}
		return lines(assistantRecord(head.ID, ts, model, protocol.ContentBlock{Type: "text", Text: it.Text}))
	case "reasoning":
		var it struct {
			Summary []string `json:"summary"`
		}
		_ = json.Unmarshal(item, &it)
		text := strings.TrimSpace(strings.Join(it.Summary, "\n"))
		if text == "" {
			return nil
		}
		return lines(assistantRecord(head.ID, ts, model, protocol.ContentBlock{Type: "thinking", Text: text}))
	case "commandExecution":
		var it struct {
			Command          string  `json:"command"`
			AggregatedOutput *string `json:"aggregatedOutput"`
			ExitCode         *int    `json:"exitCode"`
			Status           string  `json:"status"`
		}
		_ = json.Unmarshal(item, &it)
		out := ""
		if it.AggregatedOutput != nil {
			out = *it.AggregatedOutput
		}
		if it.ExitCode != nil && *it.ExitCode != 0 {
			out = strings.TrimRight(out, "\n") + fmt.Sprintf("\n(exit code %d)", *it.ExitCode)
		} else if it.Status == "declined" {
			out = "(declined)"
		}
		return lines(assistantRecord(head.ID, ts, model,
			toolUse(head.ID, "Bash", map[string]string{"command": shellCommand(it.Command)}),
			toolResult(head.ID, out),
		))
	case "fileChange":
		var it struct {
			Changes []struct {
				Path string `json:"path"`
				Kind struct {
					Type string `json:"type"`
				} `json:"kind"`
				Diff string `json:"diff"`
			} `json:"changes"`
			Status string `json:"status"`
		}
		_ = json.Unmarshal(item, &it)
		var blocks []protocol.ContentBlock
		for i, ch := range it.Changes {
			name := "Edit"
			switch ch.Kind.Type {
			case "add":
				name = "Write"
			case "delete":
				name = "Delete"
			}
			id := fmt.Sprintf("%s-%d", head.ID, i)
			blocks = append(blocks,
				toolUse(id, name, map[string]string{"file_path": ch.Path, "diff": ch.Diff}),
				toolResult(id, it.Status),
			)
		}
		if len(blocks) == 0 {
			return nil
		}
		return lines(assistantRecord(head.ID, ts, model, blocks...))
	case "mcpToolCall":
		var it struct {
			Server    string          `json:"server"`
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
			Result    json.RawMessage `json:"result"`
			Error     json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(item, &it)
		out := string(it.Result)
		if len(it.Error) > 0 && string(it.Error) != "null" {
			out = string(it.Error)
		}
		use := protocol.ContentBlock{Type: "tool_use", ID: head.ID, Name: "mcp__" + it.Server + "__" + it.Tool, Input: rawOrEmpty(it.Arguments)}
		return lines(assistantRecord(head.ID, ts, model, use, toolResult(head.ID, out)))
	case "webSearch":
		var it struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(item, &it)
		return lines(assistantRecord(head.ID, ts, model, toolUse(head.ID, "WebSearch", map[string]string{"query": it.Query})))
	}
	return nil
}

// ErrorRecord renders a turn Codex couldn't finish as a line of the reply, in
// Codex's own words, so the chat doesn't just stop.
func ErrorRecord(id, message string, at time.Time) []byte {
	text := "Codex stopped: " + ErrorText(message)
	return assistantRecord(id, at.UTC().Format(time.RFC3339Nano), "", protocol.ContentBlock{Type: "text", Text: text})
}

// ErrorText is the readable part of a Codex error. Codex often passes the
// API's error on as JSON in the message ({"error":{"message":"…"}}).
func ErrorText(message string) string {
	var api struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(message), &api) == nil && api.Error.Message != "" {
		return api.Error.Message
	}
	return message
}

// record is the on-disk line: the subset conversation.Watcher decodes.
type record struct {
	Type      string  `json:"type"`
	UUID      string  `json:"uuid"`
	ParentID  *string `json:"parentUuid"`
	Timestamp string  `json:"timestamp"`
	Message   struct {
		Role    string `json:"role"`
		Model   string `json:"model,omitempty"`
		Content any    `json:"content"`
	} `json:"message"`
}

func userRecord(id, ts, text string) []byte {
	r := record{Type: "user", UUID: id, Timestamp: ts}
	r.Message.Role = "user"
	r.Message.Content = text
	return marshal(r)
}

func assistantRecord(id, ts, model string, blocks ...protocol.ContentBlock) []byte {
	r := record{Type: "assistant", UUID: id, Timestamp: ts}
	r.Message.Role = "assistant"
	r.Message.Model = model
	r.Message.Content = blocks
	return marshal(r)
}

func marshal(r record) []byte {
	line, err := json.Marshal(r)
	if err != nil {
		return nil
	}
	return append(line, '\n')
}

func lines(line []byte) [][]byte {
	if line == nil {
		return nil
	}
	return [][]byte{line}
}

func toolUse(id, name string, input map[string]string) protocol.ContentBlock {
	raw, _ := json.Marshal(input)
	return protocol.ContentBlock{Type: "tool_use", ID: id, Name: name, Input: raw}
}

func toolResult(id, content string) protocol.ContentBlock {
	raw, _ := json.Marshal(content)
	return protocol.ContentBlock{Type: "tool_result", ToolUseID: id, Content: raw}
}

func rawOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage("{}")
	}
	return raw
}

// Codex runs each command through a login shell: "/bin/bash -lc 'ls -a'".
// The chat shows the command the model wrote.
var shellWrapper = regexp.MustCompile(`^/bin/(?:ba|z)?sh -lc '(.*)'$`)

func shellCommand(command string) string {
	m := shellWrapper.FindStringSubmatch(command)
	if m == nil {
		return command
	}
	return strings.ReplaceAll(m[1], `'\''`, `'`)
}

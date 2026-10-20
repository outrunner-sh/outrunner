package codex

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	"runtime-agent/internal/protocol"
)

// Codex records a session in a rollout: $CODEX_HOME/sessions/YYYY/MM/DD/
// rollout-<time>-<id>.jsonl, one JSON line per item, appended as the session
// goes (codex-cli 0.146.0). The conversation stream, the Summary and Archive
// all read Claude's transcript shape, so a Codex session's rollout is
// translated into it, a line at a time, and those readers stay as they are
// (the jcode engine does the same: internal/jcode/translate.go).
//
// What is translated:
//   - event_msg user_message: the user's prompt (a user record, its text as a
//     plain string, as Claude records a typed prompt);
//   - response_item message (assistant): its output_text, as text blocks, with
//     the model the latest turn_context named;
//   - response_item reasoning: its summary, as a thinking block;
//   - response_item function_call / custom_tool_call: a tool_use;
//   - response_item function_call_output / custom_tool_call_output: a user
//     record with the tool_result;
//   - event_msg token_count: the model call's usage, put on its last assistant
//     record (see Translator).
//
// Everything else is skipped: session_meta and turn_context (read for the
// session id and model), world_state, the developer and user response_items
// (Codex's instructions and injected context, and a copy of each prompt the
// user_message already gives), and the event_msgs that echo response_items.
//
// Every record's uuid is "codex-<session id>-<offset>", the byte offset of the
// rollout line it came from: translating the same rollout again gives the
// same uuids, so a translation resumed after a crash can tell what it already
// wrote (RecordOffset) and never writes it twice.

// Record is one translated line, ready to append (it ends in '\n'), and the
// offset of the rollout line it came from.
type Record struct {
	Offset int64
	Line   []byte
}

// Translator translates one rollout, its lines given in order. Not safe for
// concurrent use.
//
// A model call's usage comes in a token_count after its output (and after any
// tools it asked for have run), so the records of a call are held until it
// arrives, to carry it. Held records are given up (Flush) when the next call
// or prompt begins without one, or when the caller has waited long enough: a
// tool call must show while its tool runs, not once it is done.
type Translator struct {
	sessionID string
	model     string
	parent    *string
	// held are the current model call's records, not yet given out: its
	// assistant records, then the results of the tools they called.
	held     []held
	heldTool bool // held includes a tool result
}

type held struct {
	offset int64
	rec    record
}

// record is the Claude transcript line: the subset conversation.Watcher (and
// lib/runtime/replay/conversation.ts) read.
type record struct {
	Type      string  `json:"type"`
	UUID      string  `json:"uuid"`
	ParentID  *string `json:"parentUuid"`
	Timestamp string  `json:"timestamp"`
	Message   message `json:"message"`
}

type message struct {
	Role    string          `json:"role"`
	Model   string          `json:"model,omitempty"`
	Content json.RawMessage `json:"content"`
	Usage   *Usage          `json:"usage,omitempty"`
}

// Usage is a model call's tokens in Claude's terms: input_tokens counts only
// what was neither read from nor written to the cache, as Claude's does (in
// Codex's, input_tokens includes both).
type Usage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// NewTranslator starts translating a rollout from its first line.
func NewTranslator() *Translator { return &Translator{} }

// rolloutLine is the envelope of every rollout line.
type rolloutLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// The payloads this reads, each decoded on its own: a field one kind of line
// spells differently (turn_context's summary is a string, reasoning's a list)
// must not cost another kind its line.
type (
	sessionMeta struct {
		ID string `json:"id"`
	}
	turnContext struct {
		Model string `json:"model"`
	}
	userMessage struct {
		Message string `json:"message"`
	}
	tokenCount struct {
		Info *struct {
			Last *struct {
				Input      int `json:"input_tokens"`
				Cached     int `json:"cached_input_tokens"`
				CacheWrite int `json:"cache_write_input_tokens"`
				Output     int `json:"output_tokens"`
			} `json:"last_token_usage"`
		} `json:"info"`
	}
	responseItem struct {
		Type      string          `json:"type"`
		Role      string          `json:"role"`
		Content   []contentPart   `json:"content"`
		Summary   []contentPart   `json:"summary"`
		Name      string          `json:"name"`
		CallID    string          `json:"call_id"`
		Arguments string          `json:"arguments"`
		Input     string          `json:"input"`
		Output    json.RawMessage `json:"output"`
	}
)

type contentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Line translates the complete rollout line that starts at offset, returning
// the records it releases (none while a model call's are held). A line that
// isn't JSON (one cut short by a crash) is skipped.
func (t *Translator) Line(offset int64, line []byte) []Record {
	var l rolloutLine
	if len(bytes.TrimSpace(line)) == 0 || json.Unmarshal(line, &l) != nil {
		return nil
	}
	var kind struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(l.Payload, &kind)
	switch {
	case l.Type == "session_meta":
		var p sessionMeta
		if json.Unmarshal(l.Payload, &p) == nil {
			t.sessionID = p.ID
		}
	case l.Type == "turn_context":
		var p turnContext
		if json.Unmarshal(l.Payload, &p) == nil {
			t.model = p.Model
		}
	case l.Type == "event_msg" && kind.Type == "user_message":
		var p userMessage
		if json.Unmarshal(l.Payload, &p) != nil {
			return nil
		}
		out := t.Flush()
		if strings.TrimSpace(p.Message) == "" {
			return out // an image alone: nothing the timeline renders
		}
		return append(out, t.release(offset, t.newRecord(offset, l.Timestamp, "user", jsonString(p.Message)))...)
	case l.Type == "event_msg" && kind.Type == "token_count":
		var p tokenCount
		if json.Unmarshal(l.Payload, &p) != nil {
			return nil
		}
		return t.usage(p)
	case l.Type == "response_item":
		var p responseItem
		if json.Unmarshal(l.Payload, &p) != nil {
			return nil
		}
		return t.responseItem(offset, l.Timestamp, p)
	}
	return nil
}

func (t *Translator) responseItem(offset int64, at string, p responseItem) []Record {
	var blocks []protocol.ContentBlock
	switch p.Type {
	case "message":
		if p.Role != "assistant" {
			return nil // instructions, injected context, a copy of the prompt
		}
		for _, part := range p.Content {
			if part.Type == "output_text" && part.Text != "" {
				blocks = append(blocks, protocol.ContentBlock{Type: "text", Text: part.Text})
			}
		}
		if len(blocks) == 0 {
			return nil
		}
	case "reasoning":
		var text []string
		for _, part := range p.Summary {
			if part.Text != "" {
				text = append(text, part.Text)
			}
		}
		// Its summary may be empty (the reasoning itself is encrypted): the
		// block still shows the model thought there.
		blocks = []protocol.ContentBlock{{Type: "thinking", Text: strings.Join(text, "\n\n")}}
	case "function_call":
		blocks = []protocol.ContentBlock{{Type: "tool_use", ID: p.CallID, Name: p.Name, Input: toolInput(p.Arguments)}}
	case "custom_tool_call":
		blocks = []protocol.ContentBlock{{Type: "tool_use", ID: p.CallID, Name: p.Name, Input: toolInput(p.Input)}}
	case "function_call_output", "custom_tool_call_output":
		result := []protocol.ContentBlock{{Type: "tool_result", ToolUseID: p.CallID, Content: toolOutput(p.Output)}}
		rec := t.newRecord(offset, at, "user", mustJSON(result))
		if len(t.held) == 0 {
			return t.release(offset, rec)
		}
		t.held = append(t.held, held{offset, rec})
		t.heldTool = true
		return nil
	default:
		return nil
	}
	rec := t.newRecord(offset, at, "assistant", mustJSON(blocks))
	rec.Message.Model = t.model
	var out []Record
	if t.heldTool {
		out = t.Flush() // a new model call began without the last one's usage
	}
	t.held = append(t.held, held{offset, rec})
	return out
}

// usage puts a model call's usage on its last assistant record and releases
// the call's records. A token_count with nothing held (its records were given
// up already) is dropped.
func (t *Translator) usage(p tokenCount) []Record {
	if p.Info == nil || p.Info.Last == nil {
		return t.Flush()
	}
	last := p.Info.Last
	for i := len(t.held) - 1; i >= 0; i-- {
		if t.held[i].rec.Message.Role == "assistant" {
			t.held[i].rec.Message.Usage = &Usage{
				InputTokens:              max(last.Input-last.Cached-last.CacheWrite, 0),
				OutputTokens:             last.Output,
				CacheCreationInputTokens: last.CacheWrite,
				CacheReadInputTokens:     last.Cached,
			}
			break
		}
	}
	return t.Flush()
}

// SessionID is the rollout's Codex session id, once its session_meta is read.
func (t *Translator) SessionID() string { return t.sessionID }

// Holding reports whether records are held, waiting for their usage.
func (t *Translator) Holding() bool { return len(t.held) > 0 }

// Flush releases the held records without waiting further for their usage.
func (t *Translator) Flush() []Record {
	var out []Record
	for _, h := range t.held {
		out = append(out, t.release(h.offset, h.rec)...)
	}
	t.held, t.heldTool = nil, false
	return out
}

func (t *Translator) newRecord(offset int64, at, role string, content json.RawMessage) record {
	rec := record{Type: role, UUID: RecordUUID(t.sessionID, offset), Timestamp: at}
	rec.Message.Role = role
	rec.Message.Content = content
	return rec
}

// release renders a record, chaining it to the one released before it.
func (t *Translator) release(offset int64, rec record) []Record {
	rec.ParentID = t.parent
	uuid := rec.UUID
	t.parent = &uuid
	line, err := json.Marshal(rec)
	if err != nil {
		return nil
	}
	return []Record{{Offset: offset, Line: append(line, '\n')}}
}

// RecordUUID is the uuid of the record translated from the rollout line at
// offset in the rollout of sessionID.
func RecordUUID(sessionID string, offset int64) string {
	return "codex-" + sessionID + "-" + strconv.FormatInt(offset, 10)
}

// RecordOffset reads RecordUUID back: the session and the rollout offset a
// translated record came from; ok is false for any other uuid.
func RecordOffset(uuid string) (sessionID string, offset int64, ok bool) {
	rest, found := strings.CutPrefix(uuid, "codex-")
	i := strings.LastIndexByte(rest, '-')
	if !found || i < 0 {
		return "", 0, false
	}
	offset, err := strconv.ParseInt(rest[i+1:], 10, 64)
	if err != nil {
		return "", 0, false
	}
	return rest[:i], offset, true
}

// toolInput is a tool call's arguments as the tool_use input: the JSON object
// Codex sent, or, for anything else (a freeform tool's patch), {"raw": text}.
func toolInput(arguments string) json.RawMessage {
	trimmed := strings.TrimSpace(arguments)
	if strings.HasPrefix(trimmed, "{") && json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	return mustJSON(map[string]string{"raw": arguments})
}

// toolOutput is a tool's output as the tool_result content: its text. Codex
// writes a string; a structured output ({"content": …}) gives its content,
// and anything else is kept as it is.
func toolOutput(output json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(output)
	if len(trimmed) == 0 {
		return jsonString("")
	}
	if trimmed[0] == '{' {
		var structured struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(trimmed, &structured) == nil && len(structured.Content) > 0 {
			return structured.Content
		}
	}
	return json.RawMessage(trimmed)
}

func jsonString(s string) json.RawMessage { return mustJSON(s) }

// mustJSON marshals what can always be marshalled (strings, blocks).
func mustJSON(v any) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return data
}

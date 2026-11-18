// Package conversation turns Claude Code's session JSONL into structured events
// for the conversation UI. It is a defensive, incremental byte-offset tail
// (validated in Spike 3/4): the format is Claude's internal, undocumented,
// version-tagged log, so the parser whitelists the record types it renders and
// tolerates everything else.
//
// Every emitted event carries an ID = the JSONL byte offset AT THE END of the
// record that produced it. That ID is the resume cursor: `Last-Event-ID: N`
// (SSE) means "I've consumed everything up to byte N; give me from there."
// This guarantees zero-dupe / zero-skip resume without any pub-sub state.
package conversation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

// rawRecord is the subset of a Claude JSONL line the watcher understands.
type rawRecord struct {
	Harness *struct {
		From      string          `json:"from"`
		Agent     string          `json:"agent"`
		Selection json.RawMessage `json:"selection"`
	} `json:"outrunnerHarness"`
	Type      string  `json:"type"`
	Subtype   string  `json:"subtype"`
	UUID      string  `json:"uuid"`
	ParentID  *string `json:"parentUuid"`
	Timestamp string  `json:"timestamp"`
	// PermissionMode is the mode Claude was in when the user sent a prompt
	// ("plan"), as Claude records it on the prompt; a Codex translation
	// records it the same way.
	PermissionMode string `json:"permissionMode"`
	// IsCompactSummary marks the summary Claude starts again from after
	// compacting: a user record, but no prompt of the user's.
	IsCompactSummary bool `json:"isCompactSummary"`
	// CompactMetadata is a compact_boundary's: why, and how full it was.
	CompactMetadata *struct {
		Trigger    string `json:"trigger"`
		PreTokens  int    `json:"preTokens"`
		PostTokens int    `json:"postTokens"`
	} `json:"compactMetadata"`
	// Claude's own injected record (a skill's instructions, a system reminder,
	// …): shown tucked behind a disclosure, not inline, so it stays out of the
	// conversation's flow.
	IsMeta bool `json:"isMeta"`
	// QueueTranscriptOnly marks a record Claude only wrote down and never
	// sent the model: on resume, the notice for a background task the
	// previous process left running. No reply follows it, so it is no prompt.
	QueueTranscriptOnly bool `json:"queueTranscriptOnly"`
	Message             *struct {
		// ID is the model call's own id (Anthropic's msg_…, or whatever id
		// the endpoint answered with): the same on every record of one reply.
		ID         string                      `json:"id"`
		Role       string                      `json:"role"`
		Model      string                      `json:"model"`
		StopReason string                      `json:"stop_reason"`
		Content    json.RawMessage             `json:"content"`
		Usage      *map[string]json.RawMessage `json:"usage"`
		// ContextWindow is the model's context, which a Codex translation
		// records (Codex's log says it); Claude's log never does. And
		// ContextTokens how much of it the call used, which a translation
		// records apart from its usage (codex.Translator).
		ContextWindow int `json:"context_window"`
		ContextTokens int `json:"context_tokens"`
	} `json:"message"`
	// A prompt typed while Claude is mid-turn: queued, then taken into the
	// running turn at its next tool call, where Claude records it as this
	// attachment and never as a user message.
	Attachment *struct {
		Type        string          `json:"type"`
		Prompt      json.RawMessage `json:"prompt"`
		CommandMode string          `json:"commandMode"`
	} `json:"attachment"`
}

// rawBlock is a content block as the log writes it. Claude names a tool
// result's call `tool_use_id`; the logs Runtime writes itself (a Codex
// translation, the jcode engine's) marshal protocol.ContentBlock, which names
// it `toolUseId`. Both are read, so a result pairs with its call either way.
// Likewise a failed result: Claude's `is_error`, Runtime's `isError`; and a
// thinking block's words: Claude's `thinking`, Runtime's `text`.
type rawBlock struct {
	protocol.ContentBlock
	ClaudeToolUseID string `json:"tool_use_id"`
	ClaudeIsError   bool   `json:"is_error"`
	ClaudeThinking  string `json:"thinking"`
}

func (b rawBlock) block() protocol.ContentBlock {
	out := b.ContentBlock
	if out.ToolUseID == "" {
		out.ToolUseID = b.ClaudeToolUseID
	}
	if b.ClaudeIsError {
		out.IsError = true
	}
	if out.Type == "thinking" && out.Text == "" {
		out.Text = b.ClaudeThinking
	}
	// Only an image's source is a picture the timeline shows (a document's
	// is a PDF), and only up to MaxImageBlockData of it.
	if out.Type != "image" {
		out.Source = nil
	} else if out.Source != nil && len(out.Source.Data) > protocol.MaxImageBlockData {
		src := *out.Source
		src.Data = ""
		out.Source = &src
	}
	return out
}

// Event is a decoded conversation event. Exactly one of Message/Usage is set.
// ID is the JSONL byte offset AT THE END of the record that produced this
// event — the resume cursor the SSE handler emits as `id:`.
type Event struct {
	ID int64
	// Start is where the record begins in the file, for Read's callers (an
	// edit cuts the log there); a Watcher leaves it 0.
	Start   int64
	Message *protocol.ConversationMessage
	Usage   *protocol.TokenUsage
}

// PathFunc returns the JSONL path to tail. It may return "" while the file
// doesn't yet exist (Claude hasn't written anything); the watcher polls again
// on the next tick.
type PathFunc func() string

// Watcher incrementally tails one session file.
type Watcher struct {
	pathFn   PathFunc
	offset   int64
	partial  []byte
	interval time.Duration
	// Path last opened; a change resets offset/partial so switching JSONL
	// files (e.g. new Claude session) doesn't skip content.
	lastPath string
}

// New starts watching the path returned by pathFn, resuming from fromOffset
// (0 for a fresh subscription; a positive value from the client's last seen
// event ID for resume).
func New(pathFn PathFunc, fromOffset int64) *Watcher {
	return &Watcher{pathFn: pathFn, offset: fromOffset, interval: 250 * time.Millisecond}
}

// SetInterval overrides the poll interval (tests use short intervals).
func (w *Watcher) SetInterval(d time.Duration) { w.interval = d }

// Run polls the file until ctx is cancelled, emitting one Event per new
// user/assistant record on out, and per prompt Claude took in mid-turn (an
// attachment, decodeQueuedPrompt). Other app-internal record types
// (queue-operation, ai-title, last-prompt, mode, pr-link, system, …) are ignored.
func (w *Watcher) Run(ctx context.Context, out chan<- Event) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	// Poll once immediately so subscribers see existing history without a tick delay.
	w.poll(ctx, out)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.poll(ctx, out)
		}
	}
}

func (w *Watcher) poll(ctx context.Context, out chan<- Event) {
	path := w.pathFn()
	if path == "" {
		return
	}
	if path != w.lastPath {
		// New JSONL file (Claude switched sessions); start from the caller's
		// original offset only for the first file, then reset for later ones.
		if w.lastPath != "" {
			w.offset = 0
			w.partial = nil
		}
		w.lastPath = path
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() <= w.offset {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	if _, err := f.Seek(w.offset, 0); err != nil {
		return
	}
	buf := make([]byte, info.Size()-w.offset)
	n, _ := f.Read(buf)

	// Split into full lines; buffer any partial trailing line for the next tick.
	// lineStart tracks each full line's start offset within the file so we can
	// emit an accurate end-of-line offset as the event ID.
	data := append(w.partial, buf[:n]...)
	// The start-of-data offset within the JSONL file:
	dataStart := w.offset - int64(len(w.partial))
	w.offset += int64(n)

	cursor := dataStart
	for {
		idx := bytes.IndexByte(data, '\n')
		if idx == -1 {
			w.partial = data
			return
		}
		line := data[:idx]
		lineEnd := cursor + int64(idx) + 1 // include the '\n'
		cursor = lineEnd
		data = data[idx+1:]

		if ev, ok := decode(line); ok {
			ev.ID = lineEnd
			select {
			case <-ctx.Done():
				return
			case out <- ev:
			}
		}
	}
}

func decode(line []byte) (Event, bool) {
	if len(bytes.TrimSpace(line)) == 0 {
		return Event{}, false
	}
	var rec rawRecord
	if err := json.Unmarshal(line, &rec); err != nil {
		return Event{}, false // tolerate unparseable lines
	}
	if rec.Type == "outrunner_harness_switch" && rec.Harness != nil {
		return Event{Message: &protocol.ConversationMessage{T: "message", UUID: rec.UUID, Role: "assistant", Content: []protocol.ContentBlock{}, Harness: &protocol.HarnessChange{From: rec.Harness.From, To: rec.Harness.Agent, Selection: rec.Harness.Selection}}}, true
	}
	if rec.Type == "attachment" {
		return decodeQueuedPrompt(rec)
	}
	if rec.Type == "system" && rec.Subtype == "compact_boundary" {
		return compaction(rec), true
	}
	if rec.Type != "user" && rec.Type != "assistant" {
		return Event{}, false // ignore app-internal record types
	}
	if rec.Message == nil || rec.IsCompactSummary {
		// The summary is Claude's own record of the conversation so far,
		// shown as the compaction it follows rather than as a prompt.
		return Event{}, false
	}
	if rec.QueueTranscriptOnly {
		// Never sent to Claude: shown as a prompt, it would start a turn no
		// reply ever ends, and hold every queued message behind it.
		return Event{}, false
	}
	content, ok := parseContent(rec.Message.Content)
	if !ok {
		return Event{}, false // unusable content: not a renderable turn
	}
	msg := &protocol.ConversationMessage{
		T:          "message",
		UUID:       rec.UUID,
		ParentUUID: rec.ParentID,
		Role:       rec.Message.Role,
		// The Claude model that produced this turn (assistant lines only; user
		// turns carry none). Surfaced so the composer can show the model actually
		// in use instead of a hardcoded label.
		Model: rec.Message.Model,
		// Why the reply this record is part of stopped ("tool_use", "end_turn"):
		// Claude logs each block of a reply as its own record, so its words
		// before a tool call can end a record while the turn goes on.
		StopReason: rec.Message.StopReason,
		Timestamp:  rec.Timestamp,
		Content:    content,
		// Claude's injected record (a skill's instructions, a reminder): the
		// timeline folds it away rather than running it inline.
		Meta: rec.IsMeta,
	}
	if rec.Message.Role == "assistant" && rec.Message.Usage != nil {
		// How full the context is: what this call read, cached or not, and
		// wrote. Claude logs each block of a reply as its own record, each
		// with the reply's usage so far, so the latest is the one to read.
		if u := UsageFrom(*rec.Message.Usage); u != nil {
			// The call it was, so its usage counts once however many records
			// carry it (lib/missions/spend.ts).
			msg.CallID = rec.Message.ID
			msg.Usage = &protocol.TokenUsageAmounts{
				InputTokens:              u.InputTokens,
				OutputTokens:             u.OutputTokens,
				CacheCreationInputTokens: u.CacheCreationInputTokens,
				CacheReadInputTokens:     u.CacheReadInputTokens,
			}
		}
		msg.ContextWindow, msg.ContextTokens = rec.Message.ContextWindow, rec.Message.ContextTokens
	}
	if rec.Message.Role == "user" && rec.PermissionMode == "plan" {
		msg.Mode = "plan"
	}
	return Event{Message: msg}, true
}

// decodeQueuedPrompt turns a prompt Claude took in mid-turn into the user
// message it stands for. Claude writes such a prompt (one typed while it works,
// and the user's sends Outrunner hands it then) only as a queued_command
// attachment, after the tool result it joined; without this the prompt never
// reached the timeline, and the page, waiting for it, stayed "working" with
// every later message held in its queue. A queued background-task notice is
// the same record with another commandMode: Claude's, not the user's, so it
// stays out. The TS replay parser mirrors this.
func decodeQueuedPrompt(rec rawRecord) (Event, bool) {
	a := rec.Attachment
	if a == nil || a.Type != "queued_command" || (a.CommandMode != "" && a.CommandMode != "prompt") {
		return Event{}, false
	}
	content, ok := parseContent(a.Prompt)
	if !ok {
		return Event{}, false
	}
	return Event{Message: &protocol.ConversationMessage{
		T:          "message",
		UUID:       rec.UUID,
		ParentUUID: rec.ParentID,
		Role:       "user",
		Timestamp:  rec.Timestamp,
		Content:    content,
	}}, true
}

// compaction is a compact_boundary as the timeline shows it: an assistant
// record with nothing in it but the compaction, so a page from before
// compaction was shown skips it, and the turn reads as over, not as one
// awaiting a reply.
func compaction(rec rawRecord) Event {
	c := &protocol.Compaction{}
	if m := rec.CompactMetadata; m != nil {
		c.Trigger, c.PreTokens, c.PostTokens = m.Trigger, m.PreTokens, m.PostTokens
	}
	return Event{Message: &protocol.ConversationMessage{
		T:          "message",
		UUID:       rec.UUID,
		ParentUUID: rec.ParentID,
		Role:       "assistant",
		Timestamp:  rec.Timestamp,
		Content:    []protocol.ContentBlock{},
		Compact:    c,
	}}
}

// parseContent decodes a Claude message's `content`, which is polymorphic: a
// block array for assistant turns (and tool-result user turns), but a plain
// string for a typed user prompt (e.g. "hi\n"). The plain-string case was
// silently dropped before — the whole record failed to unmarshal — so user
// turns never reached the timeline. Returns ok=false when the record carries no
// renderable content (missing/empty/malformed), so the caller skips it. The TS
// replay parser (lib/runtime/replay/conversation.ts) mirrors this exactly.
func parseContent(raw json.RawMessage) ([]protocol.ContentBlock, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false
	}
	switch trimmed[0] {
	case '[':
		var raw []rawBlock
		if err := json.Unmarshal(trimmed, &raw); err != nil {
			return nil, false
		}
		blocks := make([]protocol.ContentBlock, len(raw))
		for i, b := range raw {
			blocks[i] = b.block()
		}
		return blocks, true
	case '"':
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return nil, false
		}
		if s = strings.TrimSpace(s); s == "" {
			return nil, false // empty prompt: nothing to render
		}
		return []protocol.ContentBlock{{Type: "text", Text: s}}, true
	default:
		return nil, false
	}
}

// UsageFrom parses a raw Claude usage payload into a TokenUsage. The watcher
// puts it on its assistant message (ConversationMessage.Usage) rather than
// emitting a usage event of its own: it is the reply's, not a line's.
func UsageFrom(raw map[string]json.RawMessage) *protocol.TokenUsage {
	if raw == nil {
		return nil
	}
	u := &protocol.TokenUsage{T: "usage"}
	_ = json.Unmarshal(raw["input_tokens"], &u.InputTokens)
	_ = json.Unmarshal(raw["output_tokens"], &u.OutputTokens)
	_ = json.Unmarshal(raw["cache_creation_input_tokens"], &u.CacheCreationInputTokens)
	_ = json.Unmarshal(raw["cache_read_input_tokens"], &u.CacheReadInputTokens)
	_ = json.Unmarshal(raw["service_tier"], &u.ServiceTier)
	return u
}

// Interrupted begins the text Claude Code records, as a user message, when the
// user stops a turn ("[Request interrupted by user]", or "… for tool use]").
// It is no prompt: the turn it follows is over.
const Interrupted = "[Request interrupted by user"

// IsInterruption reports whether a message is the record of a stopped turn.
// lib/runtime/conversation-events.ts (isInterruption) reads it the same way.
func IsInterruption(msg *protocol.ConversationMessage) bool {
	if msg == nil || msg.Role != "user" {
		return false
	}
	var text strings.Builder
	for _, block := range msg.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return strings.HasPrefix(strings.TrimSpace(text.String()), Interrupted)
}

// Read decodes the renderable records of a session file from byte offset
// from to its last whole line, each with its ID, as a Watcher delivers them:
// for a reader that wants what the conversation holds now rather than a tail
// of it (a fork's transcript, an edit finding its message). An offset inside
// a line starts at the next one.
func Read(path string, from int64) ([]Event, error) {
	var events []Event
	err := Walk(path, from, func(ev Event) bool { events = append(events, ev); return true })
	if err != nil {
		return nil, err
	}
	return events, nil
}

// Walk visits records without retaining a whole long-running chat in memory.
// Returning false stops after the current record.
func Walk(path string, from int64, visit func(Event) bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if from < 0 || from > info.Size() {
		from = 0
	}
	partial := false
	if from > 0 {
		var prior [1]byte
		if _, err := f.ReadAt(prior[:], from-1); err != nil {
			return err
		}
		partial = prior[0] != '\n'
	}
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReader(f)
	cursor := from
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		cursor += int64(len(line))
		if partial {
			partial = false
			continue
		}
		if ev, ok := decode(line); ok {
			ev.ID, ev.Start = cursor, cursor-int64(len(line))
			if !visit(ev) {
				return nil
			}
		}
	}
	return nil
}

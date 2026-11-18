package conversation

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
)

// Two consecutive assistant lines. Byte offsets (end-of-line, includes '\n'):
//   line 1 → offset 158
//   line 2 → offset 315
const twoLines = `{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"u2","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
`

func writeJSONL(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

// drain collects events on out until ctx expires or `stop` fires, then returns.
func drain(t *testing.T, out chan Event, deadline time.Duration) []Event {
	t.Helper()
	var got []Event
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case e := <-out:
			got = append(got, e)
		case <-timer.C:
			return got
		}
	}
}

func TestWatcherEmitsEventsWithEndOfLineOffsets(t *testing.T) {
	path := writeJSONL(t, twoLines)
	w := New(func() string { return path }, 0)
	w.SetInterval(5 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	out := make(chan Event, 8)
	go w.Run(ctx, out)

	got := drain(t, out, 60*time.Millisecond)
	if len(got) != 2 {
		t.Fatalf("want 2 events, got %d", len(got))
	}
	if got[0].Message == nil || got[0].Message.UUID != "u1" {
		t.Fatalf("event 0 wrong: %+v", got[0])
	}
	if got[1].Message == nil || got[1].Message.UUID != "u2" {
		t.Fatalf("event 1 wrong: %+v", got[1])
	}
	// IDs are strictly monotonic and equal end-of-line file offsets.
	if got[0].ID <= 0 || got[1].ID <= got[0].ID {
		t.Fatalf("ids should be strictly increasing, got %d then %d", got[0].ID, got[1].ID)
	}
	if got[1].ID != int64(len(twoLines)) {
		t.Fatalf("last event ID should equal file length %d, got %d", len(twoLines), got[1].ID)
	}
}

func TestWatcherResumesFromOffsetWithoutDupesOrSkips(t *testing.T) {
	path := writeJSONL(t, twoLines)

	// First watcher consumes line 1 only, records the ID it saw.
	w1 := New(func() string { return path }, 0)
	w1.SetInterval(5 * time.Millisecond)
	ctx1, cancel1 := context.WithCancel(context.Background())
	out1 := make(chan Event, 8)
	go w1.Run(ctx1, out1)
	first := <-out1
	cancel1()

	// Second watcher resumes at that offset — must emit ONLY line 2, no line 1.
	w2 := New(func() string { return path }, first.ID)
	w2.SetInterval(5 * time.Millisecond)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	out2 := make(chan Event, 8)
	go w2.Run(ctx2, out2)

	got := drain(t, out2, 60*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("resume must emit exactly one event, got %d", len(got))
	}
	if got[0].Message == nil || got[0].Message.UUID != "u2" {
		t.Fatalf("resumed event wrong: %+v", got[0])
	}
	if got[0].ID <= first.ID {
		t.Fatalf("resumed event ID %d must be strictly greater than first ID %d", got[0].ID, first.ID)
	}
}

func TestWatcherPartialTrailingLineIsBuffered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")

	// Write one full line and one partial (no trailing newline).
	partial := `{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}` + "\n" +
		`{"type":"assistant","uuid":"u2","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"y"}]`
	if err := os.WriteFile(path, []byte(partial), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	w := New(func() string { return path }, 0)
	w.SetInterval(5 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan Event, 8)
	go w.Run(ctx, out)

	got := drain(t, out, 30*time.Millisecond)
	if len(got) != 1 || got[0].Message.UUID != "u1" {
		t.Fatalf("only the complete line should emit; got %+v", got)
	}

	// Complete the partial line — the previously-buffered content plus new bytes
	// must decode into one more event.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	if _, err := f.WriteString("}}\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	_ = f.Close()

	got2 := drain(t, out, 60*time.Millisecond)
	if len(got2) != 1 || got2[0].Message.UUID != "u2" {
		t.Fatalf("completing the partial line should emit its event; got %+v", got2)
	}
}

func TestWatcherIgnoresAppInternalRecords(t *testing.T) {
	body := `{"type":"queue-operation","uuid":"x","message":{"role":"user","content":[]}}
{"type":"assistant","uuid":"u1","parentUuid":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"ai-title","uuid":"y","message":{"role":"assistant","content":[]}}
`
	path := writeJSONL(t, body)
	w := New(func() string { return path }, 0)
	w.SetInterval(5 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan Event, 8)
	go w.Run(ctx, out)

	got := drain(t, out, 30*time.Millisecond)
	if len(got) != 1 || got[0].Message.UUID != "u1" {
		t.Fatalf("app-internal records must be ignored; got %+v", got)
	}
}

func TestWatcherWaitsForFileToAppear(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "not-yet.jsonl")

	// pathFn returns "" until we flip the switch — models Claude not having
	// written its JSONL yet at connect time.
	var mu sync.Mutex
	visible := false
	pathFn := func() string {
		mu.Lock()
		defer mu.Unlock()
		if !visible {
			return ""
		}
		return path
	}

	w := New(pathFn, 0)
	w.SetInterval(5 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan Event, 8)
	go w.Run(ctx, out)

	// No file → no events.
	if got := drain(t, out, 20*time.Millisecond); len(got) != 0 {
		t.Fatalf("watcher should be idle before file exists, got %+v", got)
	}

	if err := os.WriteFile(path, []byte(twoLines), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	mu.Lock()
	visible = true
	mu.Unlock()

	got := drain(t, out, 60*time.Millisecond)
	if len(got) != 2 {
		t.Fatalf("watcher must pick up newly-appearing file; got %d events", len(got))
	}
}

func TestDecodeStringUserPromptIsVisible(t *testing.T) {
	// A typed user prompt is logged with content as a plain string; it must decode
	// into a single visible text block (the bug: it used to be dropped entirely).
	line := `{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":"hi there\n"}}`
	ev, ok := decode([]byte(line))
	if !ok || ev.Message == nil {
		t.Fatal("expected a user message event, got none")
	}
	if ev.Message.Role != "user" || len(ev.Message.Content) != 1 ||
		ev.Message.Content[0].Type != "text" || ev.Message.Content[0].Text != "hi there" {
		t.Fatalf("unexpected decode: %+v", ev.Message)
	}
}

func TestDecodeEmptyStringContentIsDropped(t *testing.T) {
	line := `{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":"   "}}`
	if _, ok := decode([]byte(line)); ok {
		t.Fatal("expected an empty-string prompt to be dropped")
	}
}

func TestDecodeCapturesAssistantModel(t *testing.T) {
	// An assistant turn carries the model that produced it; the composer shows it.
	line := `{"type":"assistant","uuid":"a","timestamp":"t","message":{"role":"assistant","model":"claude-opus-4-5-20250115","content":[{"type":"text","text":"hi"}]}}`
	ev, ok := decode([]byte(line))
	if !ok || ev.Message == nil {
		t.Fatal("expected an assistant message event, got none")
	}
	if ev.Message.Model != "claude-opus-4-5-20250115" {
		t.Fatalf("model = %q, want the assistant model", ev.Message.Model)
	}

	// A user prompt carries no model.
	userLine := `{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":"hi"}}`
	uev, ok := decode([]byte(userLine))
	if !ok || uev.Message == nil {
		t.Fatal("expected a user message event, got none")
	}
	if uev.Message.Model != "" {
		t.Fatalf("user turn model = %q, want empty", uev.Message.Model)
	}
}

func TestDecodeCarriesWhyTheReplyStopped(t *testing.T) {
	// Claude's words before a tool call: a record of their own, the turn going on.
	line := `{"type":"assistant","uuid":"a1","timestamp":"t","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"Checking."}]}}`
	ev, ok := decode([]byte(line))
	if !ok || ev.Message.StopReason != "tool_use" {
		t.Fatalf("stop reason = %q (ok %v), want tool_use", ev.Message.StopReason, ok)
	}
	// None logged: none sent, so the field is left out of the frame.
	line = `{"type":"assistant","uuid":"a2","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}`
	ev, _ = decode([]byte(line))
	frame, _ := json.Marshal(ev.Message)
	if strings.Contains(string(frame), "stopReason") {
		t.Fatalf("frame %s names a stop reason the log didn't", frame)
	}
}

func TestDecodeCarriesTheReplysUsageForTheContextRing(t *testing.T) {
	line := `{"type":"assistant","uuid":"a","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":40,"cache_creation_input_tokens":500,"cache_read_input_tokens":18000,"service_tier":"standard"}}}`
	ev, ok := decode([]byte(line))
	if !ok || ev.Message.Usage == nil {
		t.Fatalf("usage = %+v (ok %v), want the reply's", ev.Message, ok)
	}
	if u := ev.Message.Usage; u.InputTokens != 3 || u.OutputTokens != 40 || u.CacheCreationInputTokens != 500 || u.CacheReadInputTokens != 18000 {
		t.Errorf("usage = %+v", u)
	}
	if ev.Message.ContextWindow != 0 {
		t.Errorf("context window = %d from a log that says none", ev.Message.ContextWindow)
	}
	// A Codex translation says the window too.
	line = `{"type":"assistant","uuid":"b","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":4},"context_window":258400}}`
	if ev, _ := decode([]byte(line)); ev.Message.ContextWindow != 258400 {
		t.Errorf("context window = %d, want 258400", ev.Message.ContextWindow)
	}
	// And how much of it the call used, apart from usage that may sum two.
	line = `{"type":"assistant","uuid":"c","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":30,"output_tokens":4},"context_window":258400,"context_tokens":17}}`
	if ev, _ := decode([]byte(line)); ev.Message.ContextTokens != 17 {
		t.Errorf("context tokens = %d, want 17", ev.Message.ContextTokens)
	}
}

// Each block of one reply is a record of its own, each with the reply's usage
// so far: the call's id goes beside the usage, the same on every record, so a
// reader counts the call once.
func TestDecodeNamesTheCallItsUsageIsFrom(t *testing.T) {
	first := `{"type":"assistant","uuid":"a","timestamp":"t","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":""}],"usage":{"input_tokens":3,"output_tokens":1}}}`
	second := `{"type":"assistant","uuid":"b","parentUuid":"a","timestamp":"t","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":40}}}`
	for _, line := range []string{first, second} {
		if ev, _ := decode([]byte(line)); ev.Message.CallID != "msg_1" {
			t.Errorf("call id = %q, want msg_1", ev.Message.CallID)
		}
	}
	// No usage, no call id: there's nothing of the call's to count.
	user := `{"type":"user","uuid":"u","timestamp":"t","message":{"id":"x","role":"user","content":"hi"}}`
	ev, _ := decode([]byte(user))
	if frame, _ := json.Marshal(ev.Message); strings.Contains(string(frame), "callId") {
		t.Errorf("frame %s names a call", frame)
	}
}

// What Claude 2.1 writes as /compact runs: the boundary, the summary it goes
// on from (a user record, but no prompt), then the command's own records.
func TestDecodeShowsACompactionAndNotItsSummary(t *testing.T) {
	boundary := `{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","uuid":"c1","parentUuid":null,"logicalParentUuid":"a9","timestamp":"t","compactMetadata":{"trigger":"manual","preTokens":45231}}`
	ev, ok := decode([]byte(boundary))
	if !ok || ev.Message == nil || ev.Message.Compact == nil {
		t.Fatalf("boundary = %+v (ok %v), want a compaction", ev.Message, ok)
	}
	if c := ev.Message.Compact; c.Trigger != "manual" || c.PreTokens != 45231 || ev.Message.UUID != "c1" {
		t.Errorf("compaction = %+v", c)
	}
	// An assistant record with nothing in it, so an older page skips it and
	// doesn't read the turn as awaiting a reply.
	frame, _ := json.Marshal(ev.Message)
	if ev.Message.Role != "assistant" || !strings.Contains(string(frame), `"content":[]`) {
		t.Errorf("frame = %s, want an assistant record with empty content", frame)
	}
	summary := `{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"uuid":"s1","timestamp":"t","message":{"role":"user","content":"This session is being continued from a previous conversation…"}}`
	if _, ok := decode([]byte(summary)); ok {
		t.Error("the compact summary was shown as a prompt")
	}
	// Other system records stay out of the stream.
	if _, ok := decode([]byte(`{"type":"system","subtype":"api_error","uuid":"e","timestamp":"t"}`)); ok {
		t.Error("an app-internal system record was shown")
	}
}

func TestDecodeDropsANoticeNeverSentToClaude(t *testing.T) {
	// On resume, Claude only writes down the notice for a background task the
	// previous process left running: no reply follows, so it is no prompt.
	notice := `{"type":"user","uuid":"n","timestamp":"t","origin":{"kind":"task-notification"},"promptSource":"system","queueTranscriptOnly":true,"message":{"role":"user","content":"<task-notification>\n<status>stopped</status>\n</task-notification>"}}`
	if _, ok := decode([]byte(notice)); ok {
		t.Error("a transcript-only notice was shown as a prompt")
	}
	// One Claude was sent (the same notice, while idle) is a prompt, answered.
	sent := `{"type":"user","uuid":"m","timestamp":"t","origin":{"kind":"task-notification"},"promptSource":"system","message":{"role":"user","content":"<task-notification>\n<status>completed</status>\n</task-notification>"}}`
	if _, ok := decode([]byte(sent)); !ok {
		t.Error("a notice sent to Claude was dropped")
	}
}

func TestDecodeMarksAPromptSentInPlanMode(t *testing.T) {
	line := `{"type":"user","uuid":"p","timestamp":"t","permissionMode":"plan","message":{"role":"user","content":"Plan dark mode"}}`
	if ev, ok := decode([]byte(line)); !ok || ev.Message.Mode != "plan" {
		t.Fatalf("mode = %q (ok %v), want plan", ev.Message.Mode, ok)
	}
	line = `{"type":"user","uuid":"q","timestamp":"t","permissionMode":"bypassPermissions","message":{"role":"user","content":"Build it"}}`
	if ev, _ := decode([]byte(line)); ev.Message.Mode != "" {
		t.Errorf("mode = %q for a prompt in build mode, want none", ev.Message.Mode)
	}
}

func TestDecodeKeepsAPastedImage(t *testing.T) {
	// A screenshot pasted into Claude's prompt is logged as an image block
	// beside the words: the timeline shows it, so its picture comes along.
	line := `{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}},{"type":"text","text":"what is this?"}]}}`
	ev, ok := decode([]byte(line))
	if !ok || ev.Message == nil || len(ev.Message.Content) != 2 {
		t.Fatalf("expected a prompt of two blocks, got %+v", ev.Message)
	}
	img := ev.Message.Content[0]
	if img.Type != "image" || img.Source == nil || img.Source.MediaType != "image/png" || img.Source.Data != "iVBORw0KGgo=" {
		t.Fatalf("image block lost its picture: %+v", img)
	}
}

func TestDecodeLeavesOutAHugeImagesData(t *testing.T) {
	data := strings.Repeat("A", protocol.MaxImageBlockData+4)
	line := `{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"` + data + `"}}]}}`
	ev, ok := decode([]byte(line))
	if !ok || len(ev.Message.Content) != 1 {
		t.Fatalf("expected the image block, got %+v", ev.Message)
	}
	src := ev.Message.Content[0].Source
	if src == nil || src.Data != "" || src.MediaType != "image/jpeg" {
		t.Fatalf("a huge image should keep its type and lose its data: %+v", src)
	}
}

func TestDecodeDropsADocumentsSource(t *testing.T) {
	line := `{"type":"user","uuid":"x","timestamp":"t","message":{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0="}}]}}`
	ev, ok := decode([]byte(line))
	if !ok || len(ev.Message.Content) != 1 || ev.Message.Content[0].Source != nil {
		t.Fatalf("only an image carries its source: %+v", ev.Message)
	}
}

func TestDecodeKeepsWhatTheAgentThought(t *testing.T) {
	// Claude logs a thinking block's words under `thinking`; Runtime's own
	// logs (a Codex translation) under `text`. Both come through as its text.
	line := `{"type":"assistant","uuid":"a","timestamp":"t","message":{"role":"assistant","content":[{"type":"thinking","thinking":"List the files first.","signature":"sig"},{"type":"thinking","text":"Then read them."},{"type":"thinking","thinking":"","signature":"sig"}]}}`
	ev, ok := decode([]byte(line))
	if !ok || len(ev.Message.Content) != 3 {
		t.Fatalf("expected three thinking blocks, got %+v", ev.Message)
	}
	for i, want := range []string{"List the files first.", "Then read them.", ""} {
		if got := ev.Message.Content[i]; got.Type != "thinking" || got.Text != want {
			t.Errorf("block %d = %+v, want thinking %q", i, got, want)
		}
	}
	// Only a thinking block's: a text block's `thinking` isn't its words.
	line = `{"type":"assistant","uuid":"b","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","thinking":"no"}]}}`
	if ev, _ := decode([]byte(line)); ev.Message.Content[0].Text != "" {
		t.Errorf("text block = %+v", ev.Message.Content[0])
	}
}

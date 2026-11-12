package ask

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func pending(t *testing.T, b *Broker) PendingCall {
	t.Helper()
	call, ok := b.Pending("ws")
	if !ok {
		t.Fatal("no call pending")
	}
	return call
}

func picked(label string) Reply {
	return Reply{Answers: []Answer{{Selected: []string{label}}, {Selected: []string{"Mac"}}}}
}

// A call is published only once the broker holds it, under this launch's
// epoch, with the relay's request id as its callId.
func TestPendingNamesTheHeldCall(t *testing.T) {
	b := NewBroker()
	if _, ok := b.Pending("ws"); ok {
		t.Fatal("pending before any call")
	}
	done := askAsync(t, context.Background(), b, "r1", questions())
	call := pending(t, b)
	if call.CallID != "r1" || call.LaunchEpoch != b.LaunchEpoch() || call.LaunchEpoch == "" {
		t.Fatalf("pending = %+v", call)
	}
	if _, err := b.AnswerCall("ws", call.CallIdentity, "op1", nil, Reply{Dismissed: true}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, ok := b.Pending("ws"); ok {
		t.Fatal("still pending after its answer")
	}
	if NewBroker().LaunchEpoch() == b.LaunchEpoch() {
		t.Fatal("two launches share an epoch")
	}
}

// The same questions asked twice are two calls: an answer meant for the
// first never reaches the second, though the text matches.
func TestAnAnswerToAnEarlierIdenticalCallIsStale(t *testing.T) {
	b := NewBroker()
	first := askAsync(t, context.Background(), b, "r1", questions())
	firstID := pending(t, b).CallIdentity
	if _, err := b.AnswerCall("ws", firstID, "op1", questions(), picked("DB columns")); err != nil {
		t.Fatal(err)
	}
	<-first

	second := askAsync(t, context.Background(), b, "r2", questions())
	// A second answer for the first call, under a new operation (another
	// tab, a Slack button pressed twice): stale, not delivered to r2.
	_, err := b.AnswerCall("ws", firstID, "op2", questions(), picked("Agent facts"))
	if !errors.Is(err, ErrStaleCall) || !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("answer to the first call = %v, want ErrStaleCall", err)
	}
	// The legacy, text-matched answer would have gone to r2: still waiting.
	if call := pending(t, b); call.CallID != "r2" {
		t.Fatalf("pending = %+v", call)
	}
	if _, err := b.AnswerCall("ws", pending(t, b).CallIdentity, "op3", nil, picked("Agent facts")); err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
}

// A relay that reconnects within a launch asks again with the same request
// id: the call keeps its identity, and an answer named for it is delivered
// to the newer wait.
func TestAReconnectKeepsTheCallsIdentity(t *testing.T) {
	b := NewBroker()
	first := askAsync(t, context.Background(), b, "r1", questions())
	before := pending(t, b).CallIdentity
	got := make(chan Reply, 1)
	go func() {
		reply, _ := b.Ask(context.Background(), "ws", "r1", questions())
		got <- reply
	}()
	if err := <-first; !errors.Is(err, ErrReplaced) {
		t.Fatalf("first wait = %v, want ErrReplaced", err)
	}
	if after := pending(t, b).CallIdentity; after != before {
		t.Fatalf("identity changed on reconnect: %+v -> %+v", before, after)
	}
	if _, err := b.AnswerCall("ws", before, "op1", nil, picked("DB columns")); err != nil {
		t.Fatal(err)
	}
	if r := <-got; r.Answers[0].Selected[0] != "DB columns" {
		t.Fatalf("reply = %+v", r)
	}
}

// A new launch of the agent rotates the epoch: the relay asks again with
// the same request id, and an answer named under the old launch is refused.
func TestAnAnswerFromBeforeARestartIsStale(t *testing.T) {
	old := NewBroker()
	gone := askAsync(t, context.Background(), old, "r1", questions())
	stale := pending(t, old).CallIdentity
	_ = gone

	restarted := NewBroker()
	done := askAsync(t, context.Background(), restarted, "r1", questions())
	now := pending(t, restarted).CallIdentity
	if now.CallID != stale.CallID || now.LaunchEpoch == stale.LaunchEpoch {
		t.Fatalf("identity across a restart: %+v -> %+v", stale, now)
	}
	if _, err := restarted.AnswerCall("ws", stale, "op1", nil, picked("DB columns")); !errors.Is(err, ErrStaleCall) {
		t.Fatalf("answer under the old epoch = %v, want ErrStaleCall", err)
	}
	if _, err := restarted.AnswerCall("ws", now, "op2", nil, picked("DB columns")); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// An answer whose response was lost (a timeout) is retried under the same
// operation id: the receipt says it was delivered, and nothing is delivered
// twice. The operation id reused for another answer is a conflict.
func TestAnAnswerOperationIsIdempotent(t *testing.T) {
	b := NewBroker()
	done := askAsync(t, context.Background(), b, "r1", questions())
	id := pending(t, b).CallIdentity
	if res, err := b.AnswerCall("ws", id, "op1", nil, picked("DB columns")); err != nil || res.Replayed {
		t.Fatalf("first = %+v %v", res, err)
	}
	<-done
	if res, err := b.AnswerCall("ws", id, "op1", nil, picked("DB columns")); err != nil || !res.Replayed {
		t.Fatalf("retry = %+v %v, want replayed", res, err)
	}
	if _, err := b.AnswerCall("ws", id, "op1", nil, picked("Agent facts")); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("op reused for another reply = %v, want ErrOperationConflict", err)
	}
	if _, err := b.AnswerCall("other", id, "op1", nil, picked("DB columns")); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("op reused in another session = %v, want ErrOperationConflict", err)
	}
	// Even with a new identical call waiting, the retry delivers nothing.
	again := askAsync(t, context.Background(), b, "r2", questions())
	if res, err := b.AnswerCall("ws", id, "op1", nil, picked("DB columns")); err != nil || !res.Replayed {
		t.Fatalf("retry with r2 waiting = %+v %v", res, err)
	}
	if pending(t, b).CallID != "r2" {
		t.Fatal("r2 answered by a retry")
	}
	_ = again
}

// A call given up (the relay's wait timed out, the agent was interrupted)
// leaves no receipt to deliver to: its answer is a conflict, and a retry
// of it reconciles to the same.
func TestAnAnswerToATimedOutCallIsRefused(t *testing.T) {
	b := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	done := askAsync(t, ctx, b, "r1", questions())
	id := pending(t, b).CallIdentity
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("wait = %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := b.AnswerCall("ws", id, "op1", nil, picked("DB columns")); !errors.Is(err, ErrNotWaiting) {
			t.Fatalf("try %d = %v, want ErrNotWaiting", i, err)
		}
	}
}

// An answer whose questions differ from the call's is refused, as is one
// that doesn't fit them; neither leaves a receipt.
func TestAnAnswerToACallIsChecked(t *testing.T) {
	b := NewBroker()
	done := askAsync(t, context.Background(), b, "r1", questions())
	id := pending(t, b).CallIdentity
	other := questions()
	other[0].Question = "Something else?"
	if _, err := b.AnswerCall("ws", id, "op1", other, picked("DB columns")); !errors.Is(err, ErrStaleCall) {
		t.Fatalf("other questions = %v", err)
	}
	if _, err := b.AnswerCall("ws", id, "op1", nil, picked("Nope")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad reply = %v", err)
	}
	if _, err := b.AnswerCall("ws", CallIdentity{CallID: "r1"}, "op1", nil, picked("DB columns")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("no epoch = %v", err)
	}
	if _, err := b.AnswerCall("ws", id, "op1", nil, picked("DB columns")); err != nil {
		t.Fatal(err)
	}
	<-done
}

// Receipts are bounded: the oldest are forgotten past maxReceipts.
func TestReceiptsAreBounded(t *testing.T) {
	b := NewBroker()
	for i := 0; i < maxReceipts+10; i++ {
		b.remember(fmt.Sprint("op", i), receipt{workspaceID: "ws"})
	}
	if len(b.receipts) != maxReceipts || len(b.order) != maxReceipts {
		t.Fatalf("receipts = %d, order = %d", len(b.receipts), len(b.order))
	}
	if _, ok := b.receipts["op0"]; ok {
		t.Fatal("oldest receipt kept")
	}
}

// The legacy answer, by text, still works for a client that names no call.
func TestLegacyAnswersStillMatchByText(t *testing.T) {
	b := NewBroker()
	done := askAsync(t, context.Background(), b, "r1", questions())
	if err := b.Answer("ws", questions(), picked("DB columns")); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// The relay passes on the tool_use id Claude names in _meta, as a hint.
func TestToolUseHint(t *testing.T) {
	b := NewBroker()
	go func() { _, _ = b.AskCall(context.Background(), "ws", "r1", "toolu_1", questions()) }()
	waitFor(t, func() bool { _, ok := b.Pending("ws"); return ok })
	if call := pending(t, b); call.ToolUseHint != "toolu_1" {
		t.Fatalf("hint = %q", call.ToolUseHint)
	}
}

func TestToolUseHintIsReadFromClaudesMeta(t *testing.T) {
	cases := map[string]string{
		`{"claudecode/toolUseId":"toolu_1"}`: "toolu_1",
		`{}`:                                 "",
		`{"claudecode/toolUseId":7}`:         "",
		`{"claudecode/toolUseId":"` + strings.Repeat("x", 201) + `"}`: "",
	}
	for raw, want := range cases {
		var meta map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &meta); err != nil {
			t.Fatal(err)
		}
		if got := toolUseHint(meta); got != want {
			t.Errorf("%s: %q, want %q", raw, got, want)
		}
	}
}

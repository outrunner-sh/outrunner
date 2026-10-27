package ask

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func questions() []Question {
	return []Question{
		{Header: "Storage", Question: "Where should the model be stored?", Options: []Option{{Label: "DB columns"}, {Label: "Agent facts"}}},
		{Question: "Which platforms?", Options: []Option{{Label: "Mac"}, {Label: "Cloud"}, {Label: "Linux"}}, MultiSelect: true},
	}
}

// askAsync starts an Ask and returns its outcome on a channel, once the
// broker holds it.
func askAsync(t *testing.T, ctx context.Context, b *Broker, requestID string, qs []Question) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := b.Ask(ctx, "ws", requestID, qs)
		done <- err
	}()
	waitFor(t, func() bool {
		b.held.mu.Lock()
		defer b.held.mu.Unlock()
		w := b.held.waiting["ws"]
		return w != nil && w.requestID == requestID
	})
	return done
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition never held")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestBrokerDeliversTheAnswerToTheWaitingCall(t *testing.T) {
	b := NewBroker()
	got := make(chan Reply, 1)
	go func() {
		reply, err := b.Ask(context.Background(), "ws", "r1", questions())
		if err != nil {
			t.Errorf("Ask: %v", err)
		}
		got <- reply
	}()
	waitFor(t, func() bool { return b.held.has("ws") })

	reply := Reply{Answers: []Answer{{Selected: []string{"DB columns"}}, {Selected: []string{"Mac", "Cloud"}, Other: "Windows"}}}
	if err := b.Answer("ws", questions(), reply); err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if r := <-got; len(r.Answers) != 2 || r.Answers[1].Other != "Windows" {
		t.Fatalf("reply = %+v", r)
	}
	// Answered once: a second answer (a double click) finds nothing waiting.
	if err := b.Answer("ws", questions(), reply); !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("second Answer = %v, want ErrNotWaiting", err)
	}
}

func TestBrokerRefusesAnswersToOtherQuestions(t *testing.T) {
	b := NewBroker()
	if err := b.Answer("ws", questions(), Reply{Dismissed: true}); !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("nothing waiting: %v, want ErrNotWaiting", err)
	}
	done := askAsync(t, context.Background(), b, "r1", questions())
	stale := questions()
	stale[0].Question = "An earlier question?"
	if err := b.Answer("ws", stale, Reply{Dismissed: true}); !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("other questions: %v, want ErrNotWaiting", err)
	}
	// An invalid reply leaves the question waiting for a valid one.
	bad := Reply{Answers: []Answer{{Selected: []string{"DB columns", "Agent facts"}}, {Other: "x"}}}
	if err := b.Answer("ws", questions(), bad); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid reply: %v, want ErrInvalid", err)
	}
	if err := b.Answer("ws", questions(), Reply{Dismissed: true}); err != nil {
		t.Fatalf("valid reply after an invalid one: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("Ask: %v", err)
	}
}

func TestBrokerOneQuestionAtATimeButARetryTakesOver(t *testing.T) {
	b := NewBroker()
	first := askAsync(t, context.Background(), b, "r1", questions())
	if _, err := b.Ask(context.Background(), "ws", "r2", questions()); !errors.Is(err, ErrBusy) {
		t.Fatalf("second question: %v, want ErrBusy", err)
	}
	// The relay asking again under the same id (its connection was cut) takes
	// the question over; the first call is ended.
	retry := askAsync(t, context.Background(), b, "r1", questions())
	if err := <-first; !errors.Is(err, ErrReplaced) {
		t.Fatalf("first call = %v, want ErrReplaced", err)
	}
	if err := b.Answer("ws", questions(), Reply{Dismissed: true}); err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if err := <-retry; err != nil {
		t.Fatalf("retry: %v", err)
	}
}

func TestBrokerForgetsAGivenUpCall(t *testing.T) {
	b := NewBroker()
	ctx, cancel := context.WithCancel(context.Background())
	done := askAsync(t, ctx, b, "r1", questions())
	cancel() // the agent was interrupted: its relay gave the call up
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Ask = %v, want context.Canceled", err)
	}
	if err := b.Answer("ws", questions(), Reply{Dismissed: true}); !errors.Is(err, ErrNotWaiting) {
		t.Fatalf("Answer after give-up = %v, want ErrNotWaiting", err)
	}
	// And the session can ask again.
	again := askAsync(t, context.Background(), b, "r2", questions())
	_ = b.Answer("ws", questions(), Reply{Dismissed: true})
	if err := <-again; err != nil {
		t.Fatalf("next question: %v", err)
	}
}

func TestValidate(t *testing.T) {
	opts := []Option{{Label: "A"}, {Label: "B"}}
	cases := map[string][]Question{
		"no questions":    {},
		"five questions":  {{Question: "1?", Options: opts}, {Question: "2?", Options: opts}, {Question: "3?", Options: opts}, {Question: "4?", Options: opts}, {Question: "5?", Options: opts}},
		"blank question":  {{Question: "  ", Options: opts}},
		"repeated":        {{Question: "Same?", Options: opts}, {Question: "Same?", Options: opts}},
		"one option":      {{Question: "Q?", Options: []Option{{Label: "A"}}}},
		"five options":    {{Question: "Q?", Options: []Option{{Label: "A"}, {Label: "B"}, {Label: "C"}, {Label: "D"}, {Label: "E"}}}},
		"blank label":     {{Question: "Q?", Options: []Option{{Label: "A"}, {Label: " "}}}},
		"duplicate label": {{Question: "Q?", Options: []Option{{Label: "A"}, {Label: "A"}}}},
	}
	for name, qs := range cases {
		if err := Validate(qs); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: Validate = %v, want ErrInvalid", name, err)
		}
	}
	if err := Validate(questions()); err != nil {
		t.Fatalf("valid questions: %v", err)
	}
}

func TestValidateReply(t *testing.T) {
	qs := questions()
	cases := map[string]Reply{
		"too few answers":         {Answers: []Answer{{Selected: []string{"DB columns"}}}},
		"empty answer":            {Answers: []Answer{{Other: "  "}, {Selected: []string{"Mac"}}}},
		"two for single-select":   {Answers: []Answer{{Selected: []string{"DB columns", "Agent facts"}}, {Selected: []string{"Mac"}}}},
		"pick plus other, single": {Answers: []Answer{{Selected: []string{"DB columns"}, Other: "both"}, {Selected: []string{"Mac"}}}},
		"unknown option":          {Answers: []Answer{{Selected: []string{"Redis"}}, {Selected: []string{"Mac"}}}},
		"dismissed with answers":  {Dismissed: true, Answers: []Answer{{Other: "x"}, {Other: "y"}}},
	}
	for name, reply := range cases {
		if err := ValidateReply(qs, reply); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: ValidateReply = %v, want ErrInvalid", name, err)
		}
	}
	ok := Reply{Answers: []Answer{{Other: "Somewhere else"}, {Selected: []string{"Mac", "Linux"}, Other: "BSD"}}}
	if err := ValidateReply(qs, ok); err != nil {
		t.Fatalf("valid reply: %v", err)
	}
}

func TestFormat(t *testing.T) {
	reply := Reply{Answers: []Answer{{Selected: []string{"DB columns"}}, {Selected: []string{"Mac", "Cloud"}, Other: " Windows "}}}
	got := Format(questions(), reply)
	for _, want := range []string{`"Where should the model be stored?" = "DB columns"`, `"Which platforms?" = "Mac, Cloud, Windows"`} {
		if !strings.Contains(got, want) {
			t.Errorf("Format missing %s:\n%s", want, got)
		}
	}
	if got := Format(questions(), Reply{Dismissed: true}); !strings.Contains(got, "dismissed") {
		t.Errorf("dismissed Format = %q", got)
	}
}

func TestOptionTakesABareString(t *testing.T) {
	var q Question
	if err := json.Unmarshal([]byte(`{"question":"Q?","options":["Yes",{"label":"No","description":"Stop"}]}`), &q); err != nil {
		t.Fatal(err)
	}
	if q.Options[0] != (Option{Label: "Yes"}) || q.Options[1] != (Option{Label: "No", Description: "Stop"}) {
		t.Fatalf("options = %+v", q.Options)
	}
}

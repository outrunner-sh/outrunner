// Package ask lets a session's agent ask the user multiple-choice questions
// that the web app answers, instead of a menu only the terminal shows.
//
// The agent calls an MCP tool, ask_user, served by a stdio relay (Relay) its
// CLI launches. The relay forwards the call to the runtime-agent, whose Broker
// holds it until the user answers in the browser (Broker.Answer) or the call is
// given up. The question itself reaches the browser through the conversation:
// the tool call is in the agent's transcript like any other.
package ask

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// ToolName is the tool as the relay serves it, ServerName the MCP server the
// agents know it by. The agents name the tool mcp__<server>__<tool>.
const (
	ToolName   = "ask_user"
	ServerName = "outrunner"
)

// QualifiedToolName is the tool as Claude and Codex name it in their transcripts
// and permission rules.
const QualifiedToolName = "mcp__" + ServerName + "__" + ToolName

// MediaToolName is the relay's tool that uploads a screenshot or recording
// for a pull request (package media, through the agent), and
// QualifiedMediaToolName the tool as Claude names it.
const (
	MediaToolName          = "upload_media"
	QualifiedMediaToolName = "mcp__" + ServerName + "__" + MediaToolName
)

// Limits are AskUserQuestion's: a few questions of a few options, each with an
// "Other" the browser always adds.
const (
	MaxQuestions = 4
	MinOptions   = 2
	MaxOptions   = 4
)

// Question is one question as the agent asks it, in Claude's AskUserQuestion
// shape.
type Question struct {
	Header      string   `json:"header,omitempty"`
	Question    string   `json:"question"`
	Options     []Option `json:"options"`
	MultiSelect bool     `json:"multiSelect,omitempty"`
}

// Option is one choice of a question.
type Option struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// UnmarshalJSON also takes an option written as a bare string ("Yes"), which a
// model sometimes sends for a schema it was told takes objects.
func (o *Option) UnmarshalJSON(data []byte) error {
	if trimmed := bytes.TrimSpace(data); len(trimmed) > 0 && trimmed[0] == '"' {
		*o = Option{}
		return json.Unmarshal(trimmed, &o.Label)
	}
	type plain Option
	return json.Unmarshal(data, (*plain)(o))
}

// Reply is the user's response: an answer per question, in order, or none at
// all when they dismissed the questions.
type Reply struct {
	Answers   []Answer `json:"answers,omitempty"`
	Dismissed bool     `json:"dismissed,omitempty"`
}

// Answer is the user's answer to one question: the options they picked (by
// label) and what they typed into "Other".
type Answer struct {
	Selected []string `json:"selected,omitempty"`
	Other    string   `json:"other,omitempty"`
}

// ErrInvalid is a question or a reply that doesn't fit the tool's rules; its
// message says which.
var ErrInvalid = errors.New("invalid")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Validate checks questions as the agent asked them. Its errors go back to the
// agent as the tool's result, so they say what to fix.
func Validate(questions []Question) error {
	if len(questions) == 0 || len(questions) > MaxQuestions {
		return invalid("ask 1 to %d questions, not %d", MaxQuestions, len(questions))
	}
	seen := map[string]bool{}
	for i, q := range questions {
		text := strings.TrimSpace(q.Question)
		if text == "" {
			return invalid("question %d has no text", i+1)
		}
		if seen[text] {
			return invalid("question %d repeats an earlier question", i+1)
		}
		seen[text] = true
		if len(q.Options) < MinOptions || len(q.Options) > MaxOptions {
			return invalid("question %d needs %d to %d options, not %d (the user can always type their own answer)", i+1, MinOptions, MaxOptions, len(q.Options))
		}
		labels := map[string]bool{}
		for j, o := range q.Options {
			label := strings.TrimSpace(o.Label)
			if label == "" {
				return invalid("question %d, option %d has no label", i+1, j+1)
			}
			if labels[label] {
				return invalid("question %d has two options labelled %q", i+1, label)
			}
			labels[label] = true
		}
	}
	return nil
}

// ValidateReply checks the browser's reply against the questions it answers:
// an answer for each, naming only their options, one at most unless the
// question takes several.
func ValidateReply(questions []Question, reply Reply) error {
	if reply.Dismissed {
		if len(reply.Answers) > 0 {
			return invalid("a dismissed question has no answers")
		}
		return nil
	}
	if len(reply.Answers) != len(questions) {
		return invalid("%d answers for %d questions", len(reply.Answers), len(questions))
	}
	for i, a := range reply.Answers {
		q := questions[i]
		if len(a.Selected) == 0 && strings.TrimSpace(a.Other) == "" {
			return invalid("question %d has no answer", i+1)
		}
		if !q.MultiSelect && len(a.Selected)+min(1, len(strings.TrimSpace(a.Other))) > 1 {
			return invalid("question %d takes one answer", i+1)
		}
		for _, label := range a.Selected {
			if !hasOption(q, label) {
				return invalid("question %d has no option %q", i+1, label)
			}
		}
	}
	return nil
}

func hasOption(q Question, label string) bool {
	for _, o := range q.Options {
		if o.Label == label {
			return true
		}
	}
	return false
}

// Format is the tool's result for the agent: each question with what the user
// answered, or that they dismissed them.
func Format(questions []Question, reply Reply) string {
	if reply.Dismissed {
		return "The user dismissed these questions without answering. Don't ask them again right away: continue with your best judgement, or ask in plain text if you can't."
	}
	var b strings.Builder
	b.WriteString("The user answered your questions:\n")
	for i, q := range questions {
		a := reply.Answers[i]
		parts := append([]string{}, a.Selected...)
		if other := strings.TrimSpace(a.Other); other != "" {
			parts = append(parts, other)
		}
		fmt.Fprintf(&b, "%q = %q\n", q.Question, strings.Join(parts, ", "))
	}
	b.WriteString("Continue with these answers in mind.")
	return b.String()
}

// ErrNotWaiting is an answer to questions no call is waiting on: answered
// already, given up (the agent was interrupted, its session ended), or from
// before the agent restarted.
var ErrNotWaiting = errors.New("this question is no longer waiting for an answer")

// ErrBusy is a second question asked while one is waiting in the same session.
var ErrBusy = errors.New("another question is already waiting for the user's answer; ask one set of questions at a time")

// ErrReplaced ends a call whose relay asked again with the same request: the
// newer call waits in its place.
var ErrReplaced = errors.New("asked again")

// Broker holds each session's waiting question until the user answers it.
// A session waits on one at a time: the card the browser shows is one set of
// questions.
type Broker struct{ held holder[[]Question, Reply] }

func NewBroker() *Broker { return &Broker{held: newHolder[[]Question, Reply]()} }

// Ask waits for the user's reply to questions asked in a session, until ctx
// ends (the relay gave the call up). requestID names the call: a relay that
// lost its connection asks again with the same one, and that call takes over
// from the first rather than being refused as a second question.
func (b *Broker) Ask(ctx context.Context, workspaceID, requestID string, questions []Question) (Reply, error) {
	if err := Validate(questions); err != nil {
		return Reply{}, err
	}
	return b.held.wait(ctx, workspaceID, requestID, questions, nil)
}

// Answer delivers the user's reply to the questions a session is waiting on.
// questions are the ones the browser showed: an answer to any others (an
// earlier set, a set from before a restart) is ErrNotWaiting.
func (b *Broker) Answer(workspaceID string, questions []Question, reply Reply) error {
	return b.held.answer(workspaceID, func(asked []Question) (Reply, error) {
		if !reflect.DeepEqual(asked, questions) {
			return Reply{}, ErrNotWaiting
		}
		if err := ValidateReply(asked, reply); err != nil {
			return Reply{}, err
		}
		return reply, nil
	})
}

// holder keeps each session's one waiting request, of type Q, until its
// reply, of type R, is delivered or the call is given up: what the question
// and the secret request brokers share.
type holder[Q, R any] struct {
	mu      sync.Mutex
	waiting map[string]*waiter[Q, R]
}

type waiter[Q, R any] struct {
	requestID string
	request   Q
	replies   chan R
	replaced  chan struct{}
}

func newHolder[Q, R any]() holder[Q, R] { return holder[Q, R]{waiting: map[string]*waiter[Q, R]{}} }

// wait holds request as the session's waiting one until its reply, a newer
// call with the same requestID takes over (ErrReplaced), or ctx ends. One
// with another requestID while one waits is ErrBusy.
func (h *holder[Q, R]) wait(ctx context.Context, workspaceID, requestID string, request Q, started func() error) (R, error) {
	var none R
	w := &waiter[Q, R]{requestID: requestID, request: request, replies: make(chan R, 1), replaced: make(chan struct{})}
	h.mu.Lock()
	if old := h.waiting[workspaceID]; old != nil {
		if old.requestID != requestID {
			h.mu.Unlock()
			return none, ErrBusy
		}
		close(old.replaced)
	}
	h.waiting[workspaceID] = w
	// Publish only after accepting the request, and before an answer can
	// arrive. The browser must never see a form that isn't answerable yet.
	if started != nil {
		if err := started(); err != nil {
			delete(h.waiting, workspaceID)
			h.mu.Unlock()
			return none, err
		}
	}
	h.mu.Unlock()

	select {
	case reply := <-w.replies:
		return reply, nil
	case <-w.replaced:
		return none, ErrReplaced
	case <-ctx.Done():
		h.mu.Lock()
		if h.waiting[workspaceID] == w {
			delete(h.waiting, workspaceID)
		}
		h.mu.Unlock()
		return none, ctx.Err()
	}
}

// answer gives the session's waiting request to respond, which makes its
// reply or refuses (the request isn't the one answered, the answer doesn't
// fit it); a reply made is delivered. With none waiting, ErrNotWaiting.
// respond runs under the lock: whatever it does happens once, for a call
// still waiting.
func (h *holder[Q, R]) answer(workspaceID string, respond func(request Q) (R, error)) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	w := h.waiting[workspaceID]
	if w == nil {
		return ErrNotWaiting
	}
	reply, err := respond(w.request)
	if err != nil {
		return err
	}
	delete(h.waiting, workspaceID)
	w.replies <- reply
	return nil
}

// has reports whether the session has a request waiting.
func (h *holder[Q, R]) has(workspaceID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.waiting[workspaceID] != nil
}

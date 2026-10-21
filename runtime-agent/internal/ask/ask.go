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
type Broker struct {
	mu      sync.Mutex
	waiting map[string]*waiter
}

type waiter struct {
	requestID string
	questions []Question
	replies   chan Reply
	replaced  chan struct{}
}

func NewBroker() *Broker { return &Broker{waiting: map[string]*waiter{}} }

// Ask waits for the user's reply to questions asked in a session, until ctx
// ends (the relay gave the call up). requestID names the call: a relay that
// lost its connection asks again with the same one, and that call takes over
// from the first rather than being refused as a second question.
func (b *Broker) Ask(ctx context.Context, workspaceID, requestID string, questions []Question) (Reply, error) {
	if err := Validate(questions); err != nil {
		return Reply{}, err
	}
	w := &waiter{requestID: requestID, questions: questions, replies: make(chan Reply, 1), replaced: make(chan struct{})}
	b.mu.Lock()
	if old := b.waiting[workspaceID]; old != nil {
		if old.requestID != requestID {
			b.mu.Unlock()
			return Reply{}, ErrBusy
		}
		close(old.replaced)
	}
	b.waiting[workspaceID] = w
	b.mu.Unlock()

	select {
	case reply := <-w.replies:
		return reply, nil
	case <-w.replaced:
		return Reply{}, ErrReplaced
	case <-ctx.Done():
		b.mu.Lock()
		if b.waiting[workspaceID] == w {
			delete(b.waiting, workspaceID)
		}
		b.mu.Unlock()
		return Reply{}, ctx.Err()
	}
}

// Answer delivers the user's reply to the questions a session is waiting on.
// questions are the ones the browser showed: an answer to any others (an
// earlier set, a set from before a restart) is ErrNotWaiting.
func (b *Broker) Answer(workspaceID string, questions []Question, reply Reply) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	w := b.waiting[workspaceID]
	if w == nil || !reflect.DeepEqual(w.questions, questions) {
		return ErrNotWaiting
	}
	if err := ValidateReply(w.questions, reply); err != nil {
		return err
	}
	delete(b.waiting, workspaceID)
	w.replies <- reply
	return nil
}

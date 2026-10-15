package workspace

import (
	"context"
	"errors"
	"slices"
	"testing"

	"runtime-agent/internal/protocol"
)

// A Bash prompt as Claude Code 2.1.295 drew it in a 140-column pane: the command
// between dashed rules, its reason under them.
const dashedBashPrompt = ` ▐▛███▛█   Claude Code v2.1.295
❯ Use the Bash tool to run exactly this one command: for f in a.txt b.txt; do echo "== $f"; cat "$f"; done
  Printing contents of a.txt and b.txt
  ⎿  $ for f in a.txt b.txt; do echo "== $f"; cat "$f"; done
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Print contents of a.txt and b.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 for f in a.txt b.txt; do echo "== $f"; cat "$f"; done
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 A variable in this command can't be checked before it runs
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and switch to auto mode · auto mode handles these prompts for you
   3. No
 Esc to cancel · Tab to amend
`

// The same prompt in an 80-column pane, as a session drew it: the command
// boxed, and the tip wrapped onto a second line by Claude Code itself.
const boxedBashPrompt = `     test/requirements.txt client/package.json; do echo "=============== $f"; …
────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode"
 below
   │ for f in README.md server/package.json server/server.js
   │ server/db/connect.js; do echo "=============== $f";
   │ cat "$f"; done
   Run shell command
 Contains simple_expansion
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and switch to auto mode · auto mode handles these prompts for you
   3. No
 Esc to cancel · Tab to amend · ctrl+e to explain
`

func TestAPromptIsReadOffThePaneInEitherLayout(t *testing.T) {
	dashed := parsePermissionPrompt(dashedBashPrompt)
	if dashed == nil {
		t.Fatal("no prompt read from the dashed layout")
	}
	if dashed.Title != "Bash command" || dashed.Question != "Do you want to proceed?" {
		t.Errorf("dashed = %+v", dashed)
	}
	if dashed.Code != `for f in a.txt b.txt; do echo "== $f"; cat "$f"; done` {
		t.Errorf("dashed code = %q", dashed.Code)
	}
	if !slices.Equal(dashed.Detail, []string{"Print contents of a.txt and b.txt", "A variable in this command can't be checked before it runs"}) {
		t.Errorf("dashed detail = %q (the tip is left out)", dashed.Detail)
	}
	want := []protocol.PromptOption{
		{Key: "1", Label: "Yes"},
		{Key: "2", Label: "Yes, and switch to auto mode", Hint: "auto mode handles these prompts for you"},
		{Key: "3", Label: "No"},
	}
	if !slices.Equal(dashed.Options, want) {
		t.Errorf("dashed options = %+v", dashed.Options)
	}

	boxed := parsePermissionPrompt(boxedBashPrompt)
	if boxed == nil {
		t.Fatal("no prompt read from the boxed layout")
	}
	if boxed.Code != "for f in README.md server/package.json server/server.js\nserver/db/connect.js; do echo \"=============== $f\";\ncat \"$f\"; done" {
		t.Errorf("boxed code = %q", boxed.Code)
	}
	if !slices.Equal(boxed.Detail, []string{"Run shell command", "Contains simple_expansion"}) {
		t.Errorf("boxed detail = %q", boxed.Detail)
	}
	if len(boxed.Options) != 3 || boxed.ID == "" || boxed.ID == dashed.ID {
		t.Errorf("boxed = %+v", boxed)
	}
}

func TestClaudesOwnQuestionAboveThePromptBoxIsNotAPrompt(t *testing.T) {
	reply := `⏺ Do you want me to proceed?
  1. Refactor the server
  2. Add tests first
────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle)
`
	if p := parsePermissionPrompt(reply); p != nil {
		t.Fatalf("read a prompt from Claude's reply: %+v", p)
	}
	if p := parsePermissionPrompt(composerPane); p != nil {
		t.Fatalf("read a prompt from the prompt box: %+v", p)
	}
}

func TestAnAnswerIsTypedOnlyForThePromptStillWaiting(t *testing.T) {
	ctx := context.Background()
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	s.tmux = fake
	fake.running[sessionName("ws-p")] = true
	fake.pane = dashedBashPrompt

	p, err := s.PermissionPrompt(ctx, "ws-p")
	if err != nil || p == nil {
		t.Fatalf("PermissionPrompt = %v, %v", p, err)
	}
	// An option it doesn't have, or a prompt that has since changed: nothing typed.
	if err := s.AnswerPrompt(ctx, "ws-p", protocol.AnswerPromptRequest{ID: p.ID, Key: "7"}); !errors.Is(err, ErrNoPrompt) {
		t.Errorf("an unknown option = %v", err)
	}
	if err := s.AnswerPrompt(ctx, "ws-p", protocol.AnswerPromptRequest{ID: "stale", Key: "1"}); !errors.Is(err, ErrNoPrompt) {
		t.Errorf("a stale prompt = %v", err)
	}
	if len(fake.keys) != 0 {
		t.Fatalf("typed %q for a refused answer", fake.keys)
	}
	if err := s.AnswerPrompt(ctx, "ws-p", protocol.AnswerPromptRequest{ID: p.ID, Key: "1"}); err != nil {
		t.Fatalf("AnswerPrompt: %v", err)
	}
	if !slices.Equal(fake.keys, []string{"1"}) {
		t.Errorf("typed %q, want 1", fake.keys)
	}

	// Back at the prompt box, a "1" would be a message: refused.
	fake.pane = composerPane
	fake.keys = nil
	if err := s.AnswerPrompt(ctx, "ws-p", protocol.AnswerPromptRequest{ID: p.ID, Key: "1"}); !errors.Is(err, ErrNoPrompt) || len(fake.keys) != 0 {
		t.Errorf("answer at the prompt box = %v, typed %q", err, fake.keys)
	}
}

func TestASessionNotRunningWaitsOnNothing(t *testing.T) {
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	if p, err := s.PermissionPrompt(context.Background(), "ws-none"); p != nil || err != nil {
		t.Fatalf("PermissionPrompt = %v, %v", p, err)
	}
}

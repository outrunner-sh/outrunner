package workspace

import (
	"context"
	"errors"
	"testing"
)

func TestASessionWhoseClaudeEndedOnItsOwnReadsAsExited(t *testing.T) {
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	s.tmux = fake
	s.summaries["ws-x"] = newSummary("ws-x", t.TempDir())

	fake.running[sessionName("ws-x")] = true
	if got := s.SummaryOf(context.Background(), "ws-x").State; got != "running" {
		t.Fatalf("live session = %q, want running", got)
	}
	// Claude crashed: its tmux session closed with it.
	delete(fake.running, sessionName("ws-x"))
	if got := s.SummaryOf(context.Background(), "ws-x").State; got != "exited" {
		t.Fatalf("session gone = %q, want exited", got)
	}
	// tmux that can't be asked says nothing either way.
	fake.existsErr = errors.New("tmux hung")
	if got := s.SummaryOf(context.Background(), "ws-x").State; got != "running" {
		t.Fatalf("tmux unreachable = %q, want running", got)
	}
}

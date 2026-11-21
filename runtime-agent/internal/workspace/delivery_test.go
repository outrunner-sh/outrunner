package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// starvedBox is Claude's prompt box on a box short of CPU, as reproduced at
// 4% of a CPU (Claude Code 2.1.310, 2026-11-21): a paste is drawn only after
// a few looks at the screen, and an Enter pressed before then comes in as a
// blank line of the paste; a prompt Enter takes out of the box can be
// recorded only some looks later (a busy or a slow Claude).
type starvedBox struct {
	*promptBox
	pending   *string
	drawAfter int
	recordLag int
	late      []string
	lagLeft   int
	// stuck ignores the keys that clear the box.
	stuck bool
	// dropEnters is how many Enters are lost (pressed into a Claude busy
	// drawing), and onPaste runs as the paste goes in.
	dropEnters int
	onPaste    func()
}

func (b *starvedBox) look() {
	b.promptBox.mu.Lock()
	pending := b.pending
	if pending != nil {
		b.drawAfter--
		if b.drawAfter <= 0 {
			b.pending = nil
		}
	}
	var record []string
	if len(b.late) > 0 {
		if b.lagLeft--; b.lagLeft <= 0 {
			record, b.late = b.late, nil
		}
	}
	b.promptBox.mu.Unlock()
	if pending != nil && b.pending == nil {
		_ = b.promptBox.Paste(context.Background(), "", *pending)
	}
	for _, prompt := range record {
		b.promptBox.record(prompt)
	}
}

func (b *starvedBox) Paste(ctx context.Context, name, text string) error {
	if b.onPaste != nil {
		b.onPaste()
	}
	if b.drawAfter <= 0 {
		return b.promptBox.Paste(ctx, name, text)
	}
	b.promptBox.mu.Lock()
	defer b.promptBox.mu.Unlock()
	b.pending = &text
	return nil
}

func (b *starvedBox) CapturePane(ctx context.Context, name string) (string, error) {
	b.look()
	return b.promptBox.CapturePane(ctx, name)
}

func (b *starvedBox) CapturePaneStyled(ctx context.Context, name string) (string, error) {
	b.look()
	return b.promptBox.CapturePaneStyled(ctx, name)
}

func (b *starvedBox) SendKeys(ctx context.Context, name string, keys ...string) error {
	if b.stuck {
		return nil
	}
	return b.promptBox.SendKeys(ctx, name, keys...)
}

func (b *starvedBox) SendKey(ctx context.Context, name, key string) error {
	return b.SendKeys(ctx, name, key)
}

func (b *starvedBox) SubmitEnter(ctx context.Context, name string) error {
	b.promptBox.mu.Lock()
	if b.pending != nil {
		*b.pending += "\n" // read as more of the paste
		b.promptBox.mu.Unlock()
		return nil
	}
	if b.dropEnters > 0 {
		b.dropEnters--
		b.promptBox.mu.Unlock()
		return nil
	}
	if b.recordLag > 0 && len(b.lines) > 0 {
		b.late = append(b.late, strings.Join(b.lines, "\n"))
		b.lagLeft = b.recordLag
		b.lines, b.row, b.col = nil, 0, 0
		b.promptBox.mu.Unlock()
		return nil
	}
	b.promptBox.mu.Unlock()
	return b.promptBox.SubmitEnter(ctx, name)
}

// starvedSession is sessionWithPromptBox on a starvedBox, with sends paced
// for a test.
func starvedSession(t *testing.T, box *starvedBox) (*Service, string, func() []string) {
	s, inner, id, prompts := sessionWithPromptBox(t)
	box.promptBox = inner
	s.tmux = box
	saved := []time.Duration{pasteShowWait, sendConfirmWait, reEnterAfter}
	pasteShowWait, sendConfirmWait, reEnterAfter = 3*time.Second, 4*time.Second, 500*time.Millisecond
	t.Cleanup(func() { pasteShowWait, sendConfirmWait, reEnterAfter = saved[0], saved[1], saved[2] })
	return s, id, prompts
}

// Enters pressed while a paste wasn't yet drawn came in as blank lines of it:
// the prompt sat in the box, and the next went with it as one ("do the
// needful" + 14 blank lines + "whats happening", reproduced).
func TestAnEnterWaitsForThePasteToBeDrawn(t *testing.T) {
	s, id, prompts := starvedSession(t, &starvedBox{drawAfter: 3})
	if err := s.SendMessage(id, "do the needful, just dont overdo"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if got := prompts(); !slices.Equal(got, []string{"do the needful, just dont overdo"}) {
		t.Fatalf("recorded prompts = %q, want the prompt alone, with no blank lines", got)
	}
}

// A tool's result is logged as a user record: counted as a prompt, a tool step
// ending mid-send read as the prompt landing, and the send was "sent" with the
// prompt still in the box (reproduced).
func TestAToolResultIsNotThePromptLanding(t *testing.T) {
	var s *Service
	var id string
	box := &starvedBox{dropEnters: 1}
	box.onPaste = func() {
		dir := s.claudeConvDir(id)
		_ = os.MkdirAll(dir, 0o755)
		line := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}` + "\n"
		name := "s.jsonl" // where sessionWithPromptBox records its prompts
		if f, _ := s.getFacts(id); f.ClaudeSessionID != "" {
			name = f.ClaudeSessionID + ".jsonl"
		}
		file, _ := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		_, _ = file.WriteString(line)
		file.Close()
	}
	var prompts func() []string
	s, id, prompts = starvedSession(t, box)
	if err := s.SendMessage(id, "and also check the lint"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if got := prompts(); !slices.Equal(got, []string{"and also check the lint"}) {
		t.Fatalf("recorded prompts = %q: the send ended before Claude took its prompt", got)
	}
}

// Taken out of the box but recorded late (a busy or a slow Claude): the send
// went, and saying it failed made the page say "Not sent" for a prompt the
// agent then answered (reproduced).
func TestAPromptTakenButRecordedLateIsSent(t *testing.T) {
	s, id, prompts := starvedSession(t, &starvedBox{recordLag: 1000})
	if err := s.SendMessage(id, "reply with just OK"); err != nil {
		t.Fatalf("a prompt that left the box = %v, want sent", err)
	}
	if got := prompts(); len(got) != 0 {
		t.Fatalf("recorded = %q, want none yet (recorded late)", got)
	}
}

// Text left in the box that won't clear: a prompt pasted after it would go as
// one with it, so the send is refused and nothing is typed.
func TestABoxThatWontClearRefusesTheSend(t *testing.T) {
	box := &starvedBox{stuck: true}
	s, id, prompts := starvedSession(t, box)
	box.lines, box.row, box.col = []string{"an earlier prompt"}, 0, len("an earlier prompt")
	if err := s.SendMessage(id, "the next prompt"); !errors.Is(err, ErrPromptBoxHeld) {
		t.Fatalf("SendMessage = %v, want ErrPromptBoxHeld", err)
	}
	if got := strings.Join(box.lines, "\n"); got != "an earlier prompt" {
		t.Fatalf("box = %q, want it as it was", got)
	}
	if got := prompts(); len(got) != 0 {
		t.Fatalf("recorded = %q, want nothing sent", got)
	}
}

func TestOnlyPromptsCountAsUserTurns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.jsonl")
	lines := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"fix it"}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"and the lint"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}`,
		`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill"}]}}`,
		`{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>k</task-id>\n</task-notification>"}}`,
		`{"type":"queue-operation","operation":"enqueue","content":"queued one"}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := fileUserTurns(path); got != 3 {
		t.Fatalf("fileUserTurns = %d, want 3 (two prompts and a queued one)", got)
	}
}

package workspace

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// The prompt box as Claude Code 2.1.310 drew it (tmux capture-pane -e): a
// prompt a stop handed back, the box emptied, and the box mid-turn, its
// queued prompt shown above it and a dim hint in it.
func TestClaudeTypedLinesReadsThePromptBox(t *testing.T) {
	for file, want := range map[string]int{
		"claude-box-handed-back.ansi": 1,
		"claude-box-empty.ansi":       0,
		"claude-box-busy-queued.ansi": 0,
	} {
		pane, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Fatal(err)
		}
		if got := claudeTypedLines(string(pane)); got != want {
			t.Errorf("%s: %d typed lines, want %d", file, got, want)
		}
	}

	rule := "\x1b[38;5;244m" + strings.Repeat("─", 40) + "\x1b[39m"
	box := func(rows ...string) string {
		return "\x1b[39m❯ queued earlier, not in the box\n" + rule + "\n" + strings.Join(rows, "\n") + "\n" + rule + "\n  ⏵⏵ bypass permissions on"
	}
	cases := map[string]struct {
		pane string
		want int
	}{
		"a placeholder":       {box("\x1b[39m❯ \x1b[2mTry \"how does <filepath> work?\"\x1b[0m"), 0},
		"text typed":          {box("\x1b[39m❯ fix the tests"), 1},
		"three lines typed":   {box("\x1b[39m❯ one", "  two", "  three"), 3},
		"a coloured prompt":   {box("\x1b[38;5;2m❯ \x1b[2mhint\x1b[22m typed"), 1},
		"no prompt box shown": {"Choose the text style\n❯ 1. Dark mode", 0},
	}
	for name, c := range cases {
		if got := claudeTypedLines(c.pane); got != c.want {
			t.Errorf("%s: %d typed lines, want %d", name, got, c.want)
		}
	}
}

// promptBox stands in for Claude's prompt box behind tmux: a paste lands at
// the cursor, the keys edit as Claude's do, and Enter records what the box
// holds as the user's prompt, where the agent looks for it.
type promptBox struct {
	*fakeSessions
	mu       sync.Mutex
	lines    []string
	row, col int
	record   func(prompt string)
	// pressed is every key pressed into the box.
	pressed []string
}

func (b *promptBox) Paste(_ context.Context, _ string, text string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.lines) == 0 {
		b.lines = []string{""}
	}
	line := b.lines[b.row]
	parts := strings.Split(text, "\n")
	tail := line[b.col:]
	b.lines[b.row] = line[:b.col] + parts[0]
	b.lines = slices.Insert(b.lines, b.row+1, parts[1:]...)
	b.row += len(parts) - 1
	b.col = len(b.lines[b.row])
	b.lines[b.row] += tail
	return nil
}

func (b *promptBox) SendKeys(_ context.Context, _ string, keys ...string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pressed = append(b.pressed, keys...)
	for _, key := range keys {
		if len(b.lines) == 0 {
			continue
		}
		switch key {
		case "C-a":
			b.col = 0
		case "C-k":
			if b.col < len(b.lines[b.row]) {
				b.lines[b.row] = b.lines[b.row][:b.col]
			} else if b.row+1 < len(b.lines) {
				b.lines[b.row] += b.lines[b.row+1]
				b.lines = slices.Delete(b.lines, b.row+1, b.row+2)
			}
		case "BSpace":
			if b.col > 0 {
				b.lines[b.row] = b.lines[b.row][:b.col-1] + b.lines[b.row][b.col:]
				b.col--
			} else if b.row > 0 {
				b.col = len(b.lines[b.row-1])
				b.lines[b.row-1] += b.lines[b.row]
				b.lines = slices.Delete(b.lines, b.row, b.row+1)
				b.row--
			}
		}
	}
	if len(b.lines) == 1 && b.lines[0] == "" {
		b.lines, b.row, b.col = nil, 0, 0
	}
	return nil
}

func (b *promptBox) SendKey(ctx context.Context, name, key string) error {
	return b.SendKeys(ctx, name, key)
}

func (b *promptBox) SubmitEnter(context.Context, string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.lines) > 0 {
		b.record(strings.Join(b.lines, "\n"))
		b.lines, b.row, b.col = nil, 0, 0
	}
	return nil
}

func (b *promptBox) render(styled bool) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	rule := strings.Repeat("─", 40)
	rows := []string{rule}
	if len(b.lines) == 0 {
		hint := `Try "refactor this"`
		if styled {
			hint = "\x1b[2m" + hint + "\x1b[0m"
		}
		rows = append(rows, "❯ "+hint)
	}
	for i, line := range b.lines {
		if i == 0 {
			rows = append(rows, "❯ "+line)
		} else {
			rows = append(rows, "  "+line)
		}
	}
	return strings.Join(append(rows, rule, "  ⏵⏵ accept edits on (shift+tab to cycle)"), "\n")
}

func (b *promptBox) CapturePane(context.Context, string) (string, error) { return b.render(false), nil }
func (b *promptBox) CapturePaneStyled(context.Context, string) (string, error) {
	return b.render(true), nil
}

// sessionWithPromptBox is a running Claude session whose prompt box is box,
// and the prompts it records.
func sessionWithPromptBox(t *testing.T) (*Service, *promptBox, string, func() []string) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	box := &promptBox{fakeSessions: newFakeSessions()}
	s.tmux = box
	const id = "ws-box"
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: t.TempDir()}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	box.running[sessionName(id)] = true
	t.Cleanup(func() { s.stopRecorder(context.Background(), id) })
	var mu sync.Mutex
	var prompts []string
	box.record = func(prompt string) {
		mu.Lock()
		defer mu.Unlock()
		prompts = append(prompts, prompt)
		name := "s.jsonl"
		if f, _ := s.getFacts(id); f.ClaudeSessionID != "" {
			name = f.ClaudeSessionID + ".jsonl"
		}
		dir := s.claudeConvDir(id)
		_ = os.MkdirAll(dir, 0o755)
		line, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": prompt}})
		file, _ := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		_, _ = file.Write(append(line, '\n'))
		file.Close()
	}
	return s, box, id, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(prompts)
	}
}

// A stop before Claude answered puts the prompt back in its box, unsent (as
// Claude Code 2.1.310 does; testdata/claude-box-handed-back.ansi). The next
// prompt was pasted after it, and the two went as one.
func TestASendAfterAStopIsNotTypedOntoThePromptHandedBack(t *testing.T) {
	s, box, id, prompts := sessionWithPromptBox(t)
	box.lines, box.row, box.col = []string{"QUEUED while busy"}, 0, len("QUEUED while busy")
	if err := s.SendMessage(id, "SLEEPY"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if got := prompts(); !slices.Equal(got, []string{"SLEEPY"}) {
		t.Fatalf("recorded prompts = %q, want just SLEEPY", got)
	}
}

func TestASendClearsSeveralLinesLeftInTheBoxWhereverTheCursorIs(t *testing.T) {
	s, box, id, prompts := sessionWithPromptBox(t)
	box.lines, box.row, box.col = []string{"first line", "second line", "third"}, 1, 3
	if err := s.SendMessage(id, "run the tests\nthen push"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if got := prompts(); !slices.Equal(got, []string{"run the tests\nthen push"}) {
		t.Fatalf("recorded prompts = %q", got)
	}
}

func TestAnEmptyBoxGetsNoKeysBeforeASend(t *testing.T) {
	s, box, id, prompts := sessionWithPromptBox(t)
	if err := s.SendMessage(id, "hello"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if got := prompts(); !slices.Equal(got, []string{"hello"}) {
		t.Fatalf("recorded prompts = %q", got)
	}
	if len(box.pressed) != 0 {
		t.Errorf("keys pressed into an empty box: %q", box.pressed)
	}
}

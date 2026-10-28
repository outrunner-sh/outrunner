package conversation

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A whole session of a real Claude Code 2.1.304 (testdata/claude-2.1.304.jsonl):
// a plan asked for in plan mode, declined with Escape, revised, approved in
// Claude's own menu and built; a turn stopped with Escape; then /compact with
// instructions.
func TestARealClaude2_1_304SessionDecodes(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "claude-2.1.304.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var plans, planPrompts, interruptions, approvals, compactions, summaries int
	var compactPrompt bool
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		if bytes.Contains(line, []byte(`"isCompactSummary":true`)) {
			summaries++
			if _, ok := decode(line); ok {
				t.Error("the compact summary was shown as a prompt")
			}
			continue
		}
		ev, ok := decode(line)
		if !ok || ev.Message == nil {
			continue
		}
		m := ev.Message
		if c := m.Compact; c != nil {
			compactions++
			if c.Trigger != "manual" || c.PreTokens != 22269 || c.PostTokens != 3956 || m.Role != "assistant" || len(m.Content) != 0 {
				t.Errorf("compaction = %+v (%s, %d blocks)", c, m.Role, len(m.Content))
			}
		}
		if m.Role == "user" && m.Mode == "plan" {
			planPrompts++
		}
		for _, b := range m.Content {
			switch {
			case b.Type == "tool_use" && b.Name == "ExitPlanMode":
				plans++
				if !bytes.Contains(b.Input, []byte(`"plan":"# Plan: add`)) || !bytes.Contains(b.Input, []byte(`"planFilePath"`)) {
					t.Errorf("ExitPlanMode input = %.200s, want the plan and its file", b.Input)
				}
			case b.Type == "tool_result" && strings.Contains(string(b.Content), "User has approved your plan"):
				approvals++
			case b.Type == "text" && strings.HasPrefix(b.Text, "[Request interrupted by user"):
				interruptions++
			case b.Type == "text" && m.Role == "user" && strings.HasPrefix(b.Text, "/compact keep the function names"):
				compactPrompt = true // Claude records the typed command first, as a prompt
			}
		}
	}
	if plans != 2 || approvals != 1 || interruptions < 2 || compactions != 1 || planPrompts < 2 {
		t.Errorf("plans %d, approvals %d, interruptions %d, compactions %d, plan-mode prompts %d", plans, approvals, interruptions, compactions, planPrompts)
	}
	if summaries != 1 || !compactPrompt {
		t.Errorf("summaries in the log %d, typed /compact recorded %v", summaries, compactPrompt)
	}
}

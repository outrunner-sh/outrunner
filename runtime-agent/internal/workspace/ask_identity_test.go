package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"runtime-agent/internal/ask"
)

const askUse = `{"type":"assistant","uuid":"a%[1]s","timestamp":"2026-11-12T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_%[1]s","name":"mcp__outrunner__ask_user","input":{"questions":[{"question":"Where?","options":["DB",{"label":"Facts"}]}]}}]}}`
const askResult = `{"type":"user","uuid":"r%[1]s","timestamp":"2026-11-12T10:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%[1]s","content":"answered"}]}}`
const prompt = `{"type":"user","uuid":"p%[1]s","timestamp":"2026-11-12T10:00:02Z","message":{"role":"user","content":"carry on"}}`

func writeLog(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "log.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func line(format, id string) string { return strings.ReplaceAll(format, "%[1]s", id) }

func whereCall(hint string) ask.PendingCall {
	return ask.PendingCall{
		CallIdentity: ask.CallIdentity{CallID: "r", LaunchEpoch: "e"},
		Questions:    []ask.Question{{Question: "Where?", Options: []ask.Option{{Label: "DB"}, {Label: "Facts"}}}},
		ToolUseHint:  hint,
	}
}

func TestTheCallsToolUseIsVerifiedAgainstTheTranscript(t *testing.T) {
	// The same question asked twice: the first answered, the second pending.
	repeated := writeLog(t, line(askUse, "1"), line(askResult, "1"), line(askUse, "2"))
	cases := []struct {
		name string
		log  string
		call ask.PendingCall
		want string
	}{
		{"the pending one, of the same questions", repeated, whereCall(""), "toolu_2"},
		{"the hint agrees", repeated, whereCall("toolu_2"), "toolu_2"},
		{"the hint names the answered one", repeated, whereCall("toolu_1"), ""},
		{"other questions", repeated, ask.PendingCall{Questions: []ask.Question{{Question: "When?", Options: []ask.Option{{Label: "Now"}, {Label: "Later"}}}}}, ""},
		{"all answered", writeLog(t, line(askUse, "1"), line(askResult, "1")), whereCall(""), ""},
		{"a prompt since", writeLog(t, line(askUse, "1"), line(prompt, "1")), whereCall(""), ""},
		{"not written yet", writeLog(t, line(prompt, "1")), whereCall(""), ""},
		{"no log", "", whereCall(""), ""},
		{"a log not there", filepath.Join(t.TempDir(), "none.jsonl"), whereCall(""), ""},
	}
	for _, c := range cases {
		if got := verifiedToolUse(c.log, c.call); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

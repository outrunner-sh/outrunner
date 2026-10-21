package codex

import (
	"encoding/json"
	"slices"
	"testing"

	"runtime-agent/internal/claude"
)

func TestCommand(t *testing.T) {
	const update = "check_for_update_on_startup=false"
	for _, c := range []struct {
		name                                 string
		mode                                 claude.PermissionMode
		sessionID, model, effort, instructed string
		want                                 []string
	}{
		{"new, Codex's default model", claude.AcceptEdits, "", "", "", "",
			[]string{"codex", "-c", update, "-s", "workspace-write", "-a", "on-request"}},
		{"new, on a model, oriented", claude.Default, "", "gpt-6-luna", "", "Work here.\nNot there.",
			[]string{"codex", "-m", "gpt-6-luna", "-c", update, "-c", `developer_instructions="Work here.\nNot there."`, "-s", "workspace-write", "-a", "untrusted"}},
		{"resumed", claude.Plan, "01a1596f-41f4-7f30-88f4-b569d1b5bf76", "gpt-5.5", "", "",
			[]string{"codex", "resume", "01a1596f-41f4-7f30-88f4-b569d1b5bf76", "-m", "gpt-5.5", "-c", update, "-s", "read-only", "-a", "on-request"}},
		{"at an effort", claude.AcceptEdits, "", "gpt-6-sol", "xhigh", "",
			[]string{"codex", "-m", "gpt-6-sol", "-c", `model_reasoning_effort="xhigh"`, "-c", update, "-s", "workspace-write", "-a", "on-request"}},
		{"on a Runtime Computer", claude.Bypass, "", "", "", "",
			[]string{"codex", "-c", update, "--dangerously-bypass-approvals-and-sandbox"}},
		// A mode Codex has no mapping for asks before everything.
		{"unknown mode", claude.PermissionMode("yolo"), "", "", "", "",
			[]string{"codex", "-c", update, "-s", "workspace-write", "-a", "untrusted"}},
	} {
		if got := Command(c.mode, c.sessionID, c.model, c.effort, c.instructed); !slices.Equal(got, c.want) {
			t.Errorf("%s: Command = %q\nwant %q", c.name, got, c.want)
		}
	}
}

func TestTOMLStringEscapesWhatABasicStringCannotHold(t *testing.T) {
	for in, want := range map[string]string{
		"":                       `""`,
		"plain":                  `"plain"`,
		`a "quoted" word`:        `"a \"quoted\" word"`,
		`C:\path\to`:             `"C:\\path\\to"`,
		"two\nlines\r\n":         `"two\nlines\r\n"`,
		"tab\there":              `"tab\there"`,
		"bell\a nul\x00 del\x7f": `"bell\u0007 nul\u0000 del\u007F"`,
		"backspace\b feed\f":     `"backspace\b feed\f"`,
		"café 😀 ›":               `"café 😀 ›"`,
		"`code` and 'quotes'":    "\"`code` and 'quotes'\"",
	} {
		if got := TOMLString(in); got != want {
			t.Errorf("TOMLString(%q) = %s, want %s", in, got, want)
		}
	}
}

// Every escape TOMLString writes means the same in JSON, so decoding its output
// as JSON must give the input back: the whole orientation survives as one value.
func TestTOMLStringRoundTrips(t *testing.T) {
	orientation := claude.Orientation("/work/repo \"x\"", "main", true) + "\x01\t\\"
	var back string
	if err := json.Unmarshal([]byte(TOMLString(orientation)), &back); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if back != orientation {
		t.Errorf("round trip = %q, want %q", back, orientation)
	}
}

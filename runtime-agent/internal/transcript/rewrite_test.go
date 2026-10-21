package transcript

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRewriteCwdMovesOnlyWorkingDirectories(t *testing.T) {
	const from, to = "/Users/ada/conductor/workspaces/app/kelowna", "/home/runtime/workspaces/ws-1"
	lines := []string{
		// Claude Code: the record's cwd, and one in a subfolder.
		`{"type":"user","cwd":"/Users/ada/conductor/workspaces/app/kelowna","message":{"role":"user","content":"<system_instruction>x</system_instruction> fix /Users/ada/conductor/workspaces/app/kelowna/a.go"}}`,
		`{"type":"assistant","cwd":"/Users/ada/conductor/workspaces/app/kelowna/web","message":{"role":"assistant","content":[]}}`,
		// A sibling folder that only starts with the same name: not under it.
		`{"type":"user","cwd":"/Users/ada/conductor/workspaces/app/kelowna-v2"}`,
		// Codex: session_meta's and turn_context's payload.cwd.
		`{"type":"session_meta","payload":{"id":"x","cwd":"/Users/ada/conductor/workspaces/app/kelowna"}}`,
		`{"type":"turn_context","payload":{"cwd":"/Users/ada/conductor/workspaces/app/kelowna","model":"gpt"}}`,
		// Untouched: no cwd, and not JSON at all.
		`{"type":"ai-title","aiTitle":"Fix"}`,
		`not json /Users/ada/conductor/workspaces/app/kelowna`,
	}
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := RewriteCwd(path, from, to); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(got) != len(lines) {
		t.Fatalf("%d lines, want %d:\n%s", len(got), len(lines), data)
	}
	cwd := func(line string, inPayload bool) string {
		var rec struct {
			Cwd     string `json:"cwd"`
			Payload struct {
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("line no longer JSON: %s", line)
		}
		if inPayload {
			return rec.Payload.Cwd
		}
		return rec.Cwd
	}
	for i, want := range map[int]string{0: to, 1: to + "/web", 2: from + "-v2"} {
		if c := cwd(got[i], false); c != want {
			t.Errorf("line %d cwd = %q, want %q", i, c, want)
		}
	}
	for _, i := range []int{3, 4} {
		if c := cwd(got[i], true); c != to {
			t.Errorf("line %d payload.cwd = %q, want %q", i, c, to)
		}
	}
	// The conversation's own text keeps its paths and its tags.
	if !strings.Contains(got[0], `"content":"<system_instruction>x</system_instruction> fix `+from+`/a.go"`) {
		t.Errorf("message text changed: %s", got[0])
	}
	for _, i := range []int{2, 5, 6} {
		if got[i] != lines[i] {
			t.Errorf("line %d changed:\n%s\nwas\n%s", i, got[i], lines[i])
		}
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v (%v), want 0600 kept", info.Mode().Perm(), err)
	}
}

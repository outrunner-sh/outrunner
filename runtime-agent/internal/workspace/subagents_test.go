package workspace

import (
	"errors"
	"slices"
	"testing"

	"runtime-agent/internal/protocol"
)

// A session's own subagents ride on every Claude launch, as --agents, until
// they're removed; a Claude without the flag launches without them.
func TestASessionsSubagentsRideOnItsLaunch(t *testing.T) {
	s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-sub", Branch: "b", BaseBranch: "main"})
	help := "Options:\n  --agents <json>  Custom agents\n"
	fakeClaude(t, s, &help)
	agents := map[string]protocol.Subagent{"reviewer": {Description: "Reviews a diff", Prompt: "You review code.", Model: "sonnet"}}
	if err := s.SetSubagents("ws-sub", agents); err != nil {
		t.Fatalf("SetSubagents: %v", err)
	}
	got := s.launchCommand("ws-sub", wt, false)
	at := slices.Index(got, "--agents")
	if at == -1 || at+1 >= len(got) {
		t.Fatalf("launch = %q, want --agents", got)
	}
	if want := `{"reviewer":{"description":"Reviews a diff","prompt":"You review code.","model":"sonnet"}}`; got[at+1] != want {
		t.Errorf("--agents %s, want %s", got[at+1], want)
	}

	help2 := "Options:\n  --model <model>\n"
	s2, wt2 := cloudSession(t, CreateInput{WorkspaceID: "ws-old", Branch: "b", BaseBranch: "main"})
	fakeClaude(t, s2, &help2)
	if err := s2.SetSubagents("ws-old", agents); err != nil {
		t.Fatal(err)
	}
	if got := s2.launchCommand("ws-old", wt2, false); slices.Contains(got, "--agents") {
		t.Errorf("a Claude without --agents was given it: %q", got)
	}

	if err := s.SetSubagents("ws-sub", nil); err != nil {
		t.Fatalf("SetSubagents(none): %v", err)
	}
	if got := s.launchCommand("ws-sub", wt, false); slices.Contains(got, "--agents") {
		t.Errorf("removed subagents still launched: %q", got)
	}
}

func TestSubagentsAreChecked(t *testing.T) {
	for name, agents := range map[string]map[string]protocol.Subagent{
		"a bad name":    {"Bad Name": {Description: "d", Prompt: "p"}},
		"no prompt":     {"ok": {Description: "d"}},
		"an odd model":  {"ok": {Description: "d", Prompt: "p", Model: "gpt-5"}},
		"far too large": {"ok": {Description: "d", Prompt: string(make([]byte, maxSubagentsBytes))}},
	} {
		if err := ValidSubagents(agents); !errors.Is(err, ErrInvalidEnvironment) {
			t.Errorf("%s: ValidSubagents = %v, want ErrInvalidEnvironment", name, err)
		}
	}
	if err := ValidSubagents(map[string]protocol.Subagent{"ok-1": {Description: "d", Prompt: "p", Model: "inherit"}}); err != nil {
		t.Errorf("a good subagent refused: %v", err)
	}
}

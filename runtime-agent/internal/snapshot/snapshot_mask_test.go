package snapshot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStageConversationMasksSecretsAndKeepsJSONL(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "session.jsonl")
	untouched := `{"type":"user","uuid":"u1","message":{"content":"hi"}}`
	lines := untouched + "\n" +
		`{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","content":"canary-2682b7c55940\n"}]}}` + "\n" +
		`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"It's canary-2682b`
	if err := os.WriteFile(log, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	staged, err := stageConversation(t.TempDir(), log, []string{"canary-2682b7c55940"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(staged)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(string(data), "\n")
	if len(got) != 3 || got[0] != untouched {
		t.Fatalf("staged lines = %q", got)
	}
	if strings.Contains(got[1], "canary") || !json.Valid([]byte(got[1])) {
		t.Fatalf("secret line = %q", got[1])
	}
	// A line cut off mid-write keeps a partial secret: only a whole one is known.
	if !strings.HasPrefix(got[2], `{"type":"assistant"`) {
		t.Fatalf("cut-off line = %q", got[2])
	}
	if _, err := os.Stat(log); err != nil || staged == log {
		t.Fatalf("the live log must be copied, not changed")
	}
}

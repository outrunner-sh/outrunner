package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/transcript"
	"runtime-agent/internal/workspace"
)

// stoppedSessions is tmux with nothing running: an edit then cuts the log
// and leaves the agent for its next start.
type stoppedSessions struct{ workspace.Sessions }

func (stoppedSessions) SessionExists(context.Context, string) (bool, error) { return false, nil }
func (stoppedSessions) HasSession(context.Context, string) bool             { return false }
func (stoppedSessions) KillSession(context.Context, string) error           { return nil }

func TestAStreamIsToldOfAnEditAndReadsOnFromItsCut(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	const secret, id = "test-secret", "ws-rw"
	root := t.TempDir()
	svc := workspace.NewServiceWithSessions(root, stoppedSessions{})
	worktree := filepath.Join(root, "workspaces", id)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(context.Background(), workspace.CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main"}); err != nil {
		t.Fatal(err)
	}
	dir := transcript.ClaudeProjectDir(home, worktree)
	_ = os.MkdirAll(dir, 0o755)
	prompt := `{"type":"user","uuid":"u2","parentUuid":"m1","timestamp":"t2","message":{"role":"user","content":"again"}}`
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(msg1+"\n"+prompt+"\n"+msg2+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(secret, svc).Handler())
	defer ts.Close()

	token := mintToken(protocol.RuntimeTokenClaims{WorkspaceID: id, ProjectID: "p", ComputerID: "c", UserID: "u", Exp: time.Now().Add(time.Minute).Unix()}, secret)
	// A client that read the whole log.
	end := len(msg1) + len(prompt) + len(msg2) + 3
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/events?token=%s&lastEventId=%d", ts.URL, token, end), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	code, out := controlCall(t, ts.URL, secret)(id, "POST", "/workspaces/"+id+"/rewind", map[string]any{"uuid": "u2"})
	if code != http.StatusOK || out["uuid"] != "u2" || out["at"] != float64(len(msg1)+1) {
		t.Fatalf("rewind = %d %v", code, out)
	}
	frames := readSSE(t, bufio.NewReader(resp.Body), 1, 5*time.Second)
	var rewound protocol.ConversationRewound
	if err := json.Unmarshal([]byte(frames[0].Data), &rewound); err != nil || rewound.T != "rewind" || rewound.UUID != "u2" || rewound.Rewinds != 1 {
		t.Fatalf("frame = %+v (%v), want the rewind", frames[0], err)
	}
	if frames[0].ID != fmt.Sprint(len(msg1)+1) {
		t.Errorf("rewind frame id = %s, want the cut, where the stream reads on from", frames[0].ID)
	}

	// A reply is no prompt to edit.
	if code, _ := controlCall(t, ts.URL, secret)(id, "POST", "/workspaces/"+id+"/rewind", map[string]any{"uuid": "m1"}); code != http.StatusBadRequest {
		t.Errorf("rewinding a reply = %d, want 400", code)
	}
}

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
	"runtime-agent/internal/workspace"
)

type activitySessions struct {
	workspace.Sessions
	err error
}

func (s activitySessions) ListSessions(context.Context) ([]string, error) {
	return nil, s.err
}

func (activitySessions) KillSession(context.Context, string) error {
	return errors.New("no such session")
}

func TestActivityTakesOnlyTheListingTokenAndCountsWrites(t *testing.T) {
	const secret = "test-secret"
	root := t.TempDir()
	sessions := &activitySessions{}
	srv := New(secret, workspace.NewServiceWithSessions(root, sessions))
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	call := func(workspaceID, method, path string) (int, protocol.Activity) {
		t.Helper()
		req, _ := http.NewRequest(method, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+mintToken(protocol.RuntimeTokenClaims{
			WorkspaceID: workspaceID, ProjectID: "p", ComputerID: "c", UserID: "u",
			Exp: time.Now().Add(time.Minute).Unix(),
		}, secret))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out protocol.Activity
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// A workspace's own token (the kind in a /pty URL) can't read the whole box.
	if status, _ := call("ws-1", "GET", "/activity"); status != http.StatusUnauthorized {
		t.Errorf("activity with a workspace token = %d, want 401", status)
	}

	// A newly provisioned box gets a short boot grace, even when its last
	// actual input was an hour ago. No turn is open.
	srv.lastInput.Store(time.Now().Add(-time.Hour).UnixNano())
	status, booted := call(protocol.ListingWorkspaceID, "GET", "/activity")
	if status != http.StatusOK {
		t.Fatalf("activity with the listing token = %d, want 200", status)
	}
	if booted.TurnInProgress {
		t.Error("no session, yet a turn is in progress")
	}
	at, err := time.Parse(time.RFC3339, booted.LastActivity)
	if err != nil || time.Since(at) > time.Minute {
		t.Errorf("last activity = %q, want the recent boot grace", booted.LastActivity)
	}

	// Reading doesn't count as activity (a poll mustn't keep a box up)...
	call(protocol.ListingWorkspaceID, "GET", "/workspaces")
	if _, after := call(protocol.ListingWorkspaceID, "GET", "/activity"); after.LastActivity != booted.LastActivity {
		t.Errorf("a read moved last activity from %s to %s", booted.LastActivity, after.LastActivity)
	}

	// If tmux cannot be listed, the service's persisted unknown interval is
	// authoritative; a restarted agent's later boot time must not replace it.
	sessions.err = errors.New("tmux list-sessions timed out")
	since := srv.startedAt.Add(-time.Second)
	if err := os.WriteFile(filepath.Join(root, "runtime-agent-activity-unknown-since"), []byte(since.Format(time.RFC3339Nano)), 0o600); err != nil {
		t.Fatal(err)
	}
	_, unknown := call(protocol.ListingWorkspaceID, "GET", "/activity")
	unknownAt, err := time.Parse(time.RFC3339, unknown.LastActivity)
	if err != nil || !unknownAt.Before(srv.startedAt) {
		t.Errorf("unknown activity = %q, want the persisted time before agent boot", unknown.LastActivity)
	}

	// ...a control call that changes something does, even one that fails.
	call("ws-1", "POST", "/workspaces/ws-1/stop")
	_, after := call(protocol.ListingWorkspaceID, "GET", "/activity")
	if at, _ := time.Parse(time.RFC3339, after.LastActivity); time.Since(at) > time.Minute {
		t.Errorf("after a POST, last activity = %s, want now", after.LastActivity)
	}
}

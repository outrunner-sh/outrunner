package server

import (
	"net/http"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
)

func TestListingTakesOnlyTheListingToken(t *testing.T) {
	f := newServerFixture(t)
	defer f.stop()

	list := func(workspaceID string) int {
		t.Helper()
		claims := protocol.RuntimeTokenClaims{
			WorkspaceID: workspaceID, ProjectID: "local", ComputerID: "c", UserID: "desktop",
			Exp: time.Now().Add(time.Minute).Unix(),
		}
		req, err := http.NewRequest("GET", f.url+"/workspaces", nil)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+mintToken(claims, f.secret))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("perform request: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	// A workspace's own token — the kind a page sees in a /pty URL — must not
	// enumerate every other session's folder, branch and title.
	if got := list(f.workspaceID); got != http.StatusUnauthorized {
		t.Errorf("listing with a workspace token = %d, want 401", got)
	}
	if got := list(protocol.ListingWorkspaceID); got != http.StatusOK {
		t.Errorf("listing with the listing token = %d, want 200", got)
	}
}

package server

import "testing"

func TestValidWorkspaceID(t *testing.T) {
	for _, id := range []string{"ws-1", "abc123", "0f6c1c0e-4a43-4a8e-9f4e-2a8d1c3b5e77", "a_b"} {
		if !validWorkspaceID(id) {
			t.Errorf("valid id %q rejected", id)
		}
	}
	// The id is joined into paths under the agent root and names a tmux session.
	for _, id := range []string{"", "..", "../etc", "a/b", "a b", "ws:1", string(make([]byte, 129))} {
		if validWorkspaceID(id) {
			t.Errorf("unsafe id %q accepted", id)
		}
	}
}

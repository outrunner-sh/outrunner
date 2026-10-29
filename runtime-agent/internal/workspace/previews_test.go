package workspace

import (
	"os"
	"strings"
	"testing"

	"runtime-agent/internal/preview"
)

// The orientation tells a cloud session's agent how to make a preview, with
// the command it can run as is, and readies the token that command proves
// itself with; a session on the desktop hears nothing of previews.
func TestTheOrientationSaysHowToMakeAPreview(t *testing.T) {
	root := t.TempDir()
	s := NewService(root)
	s.RelayExecutable = "/opt/runtime agent/runtime-agent"
	if note := s.previewsNote("ws-1"); note != "" {
		t.Fatalf("without previews the note is %q", note)
	}

	s.UsePreviews(&preview.Client{AppURL: "https://app.outrunner.sh", SandboxID: "sb", Secret: "k"})
	note := s.previewsNote("ws-1")
	want := "'/opt/runtime agent/runtime-agent' preview --root '" + root + "' --workspace ws-1 --label 'Web app' <port>"
	if !strings.Contains(note, want) {
		t.Fatalf("note doesn't hold the command %q:\n%s", want, note)
	}
	for _, says := range []string{"not 8080", "sign in", "only the user can make it public"} {
		if !strings.Contains(note, says) {
			t.Fatalf("note doesn't say %q:\n%s", says, note)
		}
	}
	_, tokenFile := AskPaths(root, "ws-1")
	if data, err := os.ReadFile(tokenFile); err != nil || strings.TrimSpace(string(data)) == "" {
		t.Fatalf("no ask token for the command: %v", err)
	}
	if !strings.Contains(s.orientation("ws-1", root), "# Previews") {
		t.Fatal("the orientation leaves previews out")
	}
}

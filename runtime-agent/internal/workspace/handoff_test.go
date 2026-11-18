package workspace

import (
	"strings"
	"testing"

	"runtime-agent/internal/gitcred"
)

// A cloud box's agent learns how to hand a file over; the desktop app's,
// on the user's own Mac, doesn't, as its files are already theirs.
func TestHandoffNoteIsForCloudBoxesOnly(t *testing.T) {
	s := NewService(t.TempDir())
	if note := s.handoffNote(); note != "" {
		t.Fatalf("a Mac's agent got %q", note)
	}
	s.RelayExecutable = "/usr/bin/true"
	if err := s.UseGitCredential(&gitcred.Client{}); err != nil {
		t.Fatal(err)
	}
	note := s.handoffNote()
	for _, want := range []string{"can't reach", "never say a file is on their computer", "](~/exports/icons.zip)", "6 MB"} {
		if !strings.Contains(note, want) {
			t.Errorf("note lacks %q: %q", want, note)
		}
	}
	if o := s.orientation("ws-1", t.TempDir()); !strings.Contains(o, note) {
		t.Error("the orientation leaves the note out")
	}
}

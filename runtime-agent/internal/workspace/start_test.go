package workspace

import (
	"context"
	"errors"
	"os"
	"testing"
)

// stoppedSession creates an in-place workspace in its own folder, not running.
func stoppedSession(t *testing.T) (*Service, *fakeSessions, string, string) {
	t.Helper()
	s := NewService(t.TempDir())
	fake := newFakeSessions()
	s.tmux = fake
	const id = "ws-stopped"
	folder := t.TempDir()
	in := CreateInput{WorkspaceID: id, Branch: "b", BaseBranch: "main", RepoPath: folder}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { s.stopRecorder(context.Background(), id) })
	return s, fake, id, folder
}

func TestStartRefusesADeletedSession(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	if err := s.Destroy(context.Background(), id); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if _, err := s.Start(context.Background(), id, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Fatalf("Start after delete = %v, want ErrUnknownWorkspace", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("a deleted session was launched: %q", fake.launches)
	}
}

func TestStartAndResumeRefuseAWorkspaceWhoseFolderIsGone(t *testing.T) {
	t.Parallel()
	s, fake, id, folder := stoppedSession(t)
	if err := os.RemoveAll(folder); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(context.Background(), id, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("Start = %v, want ErrUnknownWorkspace", err)
	}
	if _, err := s.Resume(context.Background(), id, ""); !errors.Is(err, ErrUnknownWorkspace) {
		t.Errorf("Resume = %v, want ErrUnknownWorkspace", err)
	}
	if len(fake.launches) != 0 {
		t.Errorf("tmux was asked to start in a missing folder: %q", fake.launches)
	}
}

func TestStartStillStartsASessionWhoseFolderIsThere(t *testing.T) {
	t.Parallel()
	s, fake, id, _ := stoppedSession(t)
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !fake.HasSession(context.Background(), sessionName(id)) {
		t.Error("no session running after Start")
	}
}

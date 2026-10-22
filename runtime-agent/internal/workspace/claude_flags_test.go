package workspace

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"runtime-agent/internal/claude"
)

// fakeClaude puts a `claude` on the service's PATH whose --help is help, and
// counts the times it is read.
func fakeClaude(t *testing.T, s *Service, help *string) (path string, reads *int) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(path, []byte("v1"), 0o755); err != nil {
		t.Fatal(err)
	}
	reads = new(int)
	s.lookPath = func(file string) (string, error) { return path, nil }
	s.runCommand = func(_ context.Context, _ []string, _ string, argv ...string) ([]byte, error) {
		if !slices.Equal(argv, []string{path, "--help"}) {
			t.Errorf("ran %q, want its --help", argv)
		}
		*reads++
		return []byte(*help), nil
	}
	return path, reads
}

// A Claude from before --effort stops at once on it (Daytona's base image
// ships 2.1.19): the session launches without it rather than not at all.
func TestAClaudeWithoutEffortLaunchesWithoutIt(t *testing.T) {
	s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-old", Branch: "b", BaseBranch: "main"})
	help := "Options:\n  --model <model>  Model for the current session\n  --effort-budget <n>  not the flag\n"
	path, reads := fakeClaude(t, s, &help)
	if err := s.SetModel(context.Background(), "ws-old", ModelChoice{Model: "opus", Effort: "high"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	want := []string{"claude", "--continue", "--permission-mode", "bypassPermissions", "--append-system-prompt", s.orientation("ws-old", wt), "--model", "opus"}
	if got := s.launchCommand("ws-old", wt, true); !slices.Equal(got, want) {
		t.Fatalf("launch = %q\nwant %q", got, want)
	}
	if f, _ := s.getFacts("ws-old"); f.Effort != "high" {
		t.Errorf("recorded effort = %q, want high kept for a Claude that takes it", f.Effort)
	}

	// Read once per build: a second launch on the same binary asks again of no one.
	s.launchCommand("ws-old", wt, true)
	if *reads != 1 {
		t.Errorf("--help read %d times for one build, want 1", *reads)
	}

	// Claude upgraded in place: the new build is read, and takes the flag.
	help = "Options:\n  --effort <level>  Effort level for the current session\n"
	if err := os.WriteFile(path, []byte("v2, a bigger build"), 0o755); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if got := s.launchCommand("ws-old", wt, true); !launchedAt(got, "high") {
		t.Errorf("launch after the upgrade = %q, want --effort high", got)
	}
}

// With no Claude to ask, the flag stays: the launch fails or not on its own.
func TestEffortStaysWhenClaudeCantBeAsked(t *testing.T) {
	s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-none", Branch: "b", BaseBranch: "main"})
	s.lookPath = func(string) (string, error) { return "", os.ErrNotExist }
	if err := s.SetModel(context.Background(), "ws-none", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-launch-0123456789abcdef", Effort: "max"}, ""); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if got := s.launchCommand("ws-none", wt, true); !launchedAt(got, "max") {
		t.Errorf("launch = %q, want --effort max", got)
	}
}

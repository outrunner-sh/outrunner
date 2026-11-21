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

// These pin how a Claude session is launched and how its conversation is found
// and counted, exactly, so moving that logic behind another layer can't change
// any of it unnoticed.

// cloudSession creates a Runtime Computer session (a worktree of the mirror,
// made here so Create takes it as made), with HOME isolated so its Claude
// project directory starts empty.
func cloudSession(t *testing.T, in CreateInput) (*Service, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	if err := os.MkdirAll(s.worktreePath(in.WorkspaceID), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return s, s.worktreePath(in.WorkspaceID)
}

// inPlaceSession creates a session in a folder of the user's that isn't a
// repository, with HOME isolated.
func inPlaceSession(t *testing.T, in CreateInput) (*Service, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	s.tmux = newFakeSessions()
	in.RepoPath = t.TempDir()
	if _, err := s.Create(context.Background(), in); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return s, s.worktreePath(in.WorkspaceID)
}

// writeTranscript writes a conversation file into the session's Claude project
// directory, aged by age so "newest" is decided by the test.
func writeTranscript(t *testing.T, s *Service, id, name, content string, age time.Duration) string {
	t.Helper()
	dir := s.claudeConvDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-age)
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClaudeLaunchCommands(t *testing.T) {
	t.Run("a new worktree session", func(t *testing.T) {
		s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-new", Branch: "b", BaseBranch: "main"})
		want := []string{"claude", "--permission-mode", "bypassPermissions", "--append-system-prompt", s.orientation("ws-new", wt)}
		if got := s.launchCommand("ws-new", wt, false); !slices.Equal(got, want) {
			t.Errorf("launch = %q\nwant %q", got, want)
		}
	})
	t.Run("a worktree session resumed continues its newest conversation", func(t *testing.T) {
		s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-cont", Branch: "b", BaseBranch: "main", PermissionMode: claude.Plan})
		want := []string{"claude", "--continue", "--permission-mode", "plan", "--append-system-prompt", s.orientation("ws-cont", wt)}
		if got := s.launchCommand("ws-cont", wt, true); !slices.Equal(got, want) {
			t.Errorf("launch = %q\nwant %q", got, want)
		}
	})
	t.Run("an in-place session starts under its own id", func(t *testing.T) {
		s, wt := inPlaceSession(t, CreateInput{WorkspaceID: "ws-in", Branch: "b", BaseBranch: "main"})
		f, _ := s.getFacts("ws-in")
		if f.ClaudeSessionID == "" {
			t.Fatal("an in-place session got no conversation id")
		}
		want := []string{"claude", "--session-id", f.ClaudeSessionID, "--permission-mode", "acceptEdits", "--append-system-prompt", s.orientation("ws-in", wt)}
		// Resume or not: with no transcript yet there is nothing to resume.
		for _, resume := range []bool{false, true} {
			if got := s.launchCommand("ws-in", wt, resume); !slices.Equal(got, want) {
				t.Errorf("launch (resume=%v) = %q\nwant %q", resume, got, want)
			}
		}
	})
	t.Run("an in-place session with a transcript resumes it by id", func(t *testing.T) {
		s, wt := inPlaceSession(t, CreateInput{WorkspaceID: "ws-in", Branch: "b", BaseBranch: "main", PermissionMode: claude.Default})
		f, _ := s.getFacts("ws-in")
		writeTranscript(t, s, "ws-in", f.ClaudeSessionID+".jsonl", `{"type":"user"}`+"\n", 0)
		want := []string{"claude", "--resume", f.ClaudeSessionID, "--permission-mode", "default", "--append-system-prompt", s.orientation("ws-in", wt)}
		for _, resume := range []bool{false, true} {
			if got := s.launchCommand("ws-in", wt, resume); !slices.Equal(got, want) {
				t.Errorf("launch (resume=%v) = %q\nwant %q", resume, got, want)
			}
		}
	})
	t.Run("a model rides on --model, last", func(t *testing.T) {
		s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-m", Branch: "b", BaseBranch: "main", Model: "claude-opus-4-5[1m]"})
		want := []string{"claude", "--continue", "--permission-mode", "bypassPermissions", "--append-system-prompt", s.orientation("ws-m", wt), "--model", "claude-opus-4-5[1m]"}
		if got := s.launchCommand("ws-m", wt, true); !slices.Equal(got, want) {
			t.Errorf("launch = %q\nwant %q", got, want)
		}
	})
	t.Run("an effort rides on --effort, inside the env files", func(t *testing.T) {
		s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-e", Branch: "b", BaseBranch: "main"})
		if err := s.SetModel(context.Background(), "ws-e", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-launch-0123456789abcdef", Effort: "high"}, ""); err != nil {
			t.Fatalf("SetModel: %v", err)
		}
		want := []string{"sh", "-c", `. "$1" && shift && exec "$@"`, "sh", s.gatewayEnvPath("ws-e"),
			"claude", "--continue", "--permission-mode", "bypassPermissions", "--append-system-prompt", s.orientation("ws-e", wt), "--effort", "high"}
		if got := s.launchCommand("ws-e", wt, true); !slices.Equal(got, want) {
			t.Errorf("launch = %q\nwant %q", got, want)
		}
	})
	t.Run("a gateway session sources its key file and takes no --model", func(t *testing.T) {
		s, wt := cloudSession(t, CreateInput{WorkspaceID: "ws-g", Branch: "b", BaseBranch: "main"})
		if err := s.SetModel(context.Background(), "ws-g", ModelChoice{Model: "z-ai/glm-5.3", Gateway: claude.OpenRouter, Token: "sk-or-v1-launch-0123456789abcdef"}, ""); err != nil {
			t.Fatalf("SetModel: %v", err)
		}
		want := []string{"sh", "-c", `. "$1" && shift && exec "$@"`, "sh", s.gatewayEnvPath("ws-g"),
			"claude", "--continue", "--permission-mode", "bypassPermissions", "--append-system-prompt", s.orientation("ws-g", wt)}
		if got := s.launchCommand("ws-g", wt, true); !slices.Equal(got, want) {
			t.Errorf("launch = %q\nwant %q", got, want)
		}
	})
}

func TestClaudeSessionLogs(t *testing.T) {
	t.Run("a worktree session's log is the newest transcript in its project directory", func(t *testing.T) {
		s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-log", Branch: "b", BaseBranch: "main"})
		if got := s.SessionLog("ws-log"); got != "" {
			t.Fatalf("SessionLog before any transcript = %q, want empty", got)
		}
		writeTranscript(t, s, "ws-log", "old.jsonl", "{}\n", time.Hour)
		newest := writeTranscript(t, s, "ws-log", "new.jsonl", "{}\n", time.Minute)
		writeTranscript(t, s, "ws-log", "notes.txt", "not a transcript", 0)
		if err := os.Mkdir(filepath.Join(s.claudeConvDir("ws-log"), "dir.jsonl"), 0o755); err != nil {
			t.Fatal(err)
		}
		if got := s.SessionLog("ws-log"); got != newest {
			t.Errorf("SessionLog = %q, want %q", got, newest)
		}
	})
	t.Run("an in-place session's log is its own transcript, however new the others", func(t *testing.T) {
		s, _ := inPlaceSession(t, CreateInput{WorkspaceID: "ws-in", Branch: "b", BaseBranch: "main"})
		f, _ := s.getFacts("ws-in")
		writeTranscript(t, s, "ws-in", "someone-elses.jsonl", "{}\n", 0)
		if got := s.SessionLog("ws-in"); got != "" {
			t.Fatalf("SessionLog with only another conversation = %q, want empty", got)
		}
		own := writeTranscript(t, s, "ws-in", f.ClaudeSessionID+".jsonl", "{}\n", time.Hour)
		if got := s.SessionLog("ws-in"); got != own {
			t.Errorf("SessionLog = %q, want %q", got, own)
		}
	})
}

func TestClaudeUserTurns(t *testing.T) {
	const transcript = `{"type":"user","message":{"content":"one"}}

not json
{"type":"assistant","message":{"content":[{"type":"text","text":"{\"type\":\"user\"}"}]}}
{"type":"user","message":{"content":[{"type":"tool_result"}]}}
`
	t.Run("a worktree session counts every transcript in its project directory", func(t *testing.T) {
		s, _ := cloudSession(t, CreateInput{WorkspaceID: "ws-t", Branch: "b", BaseBranch: "main"})
		if got := s.userTurns("ws-t"); got != 0 {
			t.Fatalf("userTurns before any transcript = %d, want 0", got)
		}
		writeTranscript(t, s, "ws-t", "a.jsonl", transcript, time.Hour)
		writeTranscript(t, s, "ws-t", "b.jsonl", `{"type":"user"}`+"\n", 0)
		writeTranscript(t, s, "ws-t", "c.txt", `{"type":"user"}`+"\n", 0)
		// A tool's result is no prompt: counted as one, a tool step ending
		// mid-send read as the send's prompt landing (turnRecord.prompt).
		if got := s.userTurns("ws-t"); got != 2 {
			t.Errorf("userTurns = %d, want 2", got)
		}
	})
	t.Run("an in-place session counts only its own transcript", func(t *testing.T) {
		s, _ := inPlaceSession(t, CreateInput{WorkspaceID: "ws-in", Branch: "b", BaseBranch: "main"})
		f, _ := s.getFacts("ws-in")
		writeTranscript(t, s, "ws-in", "someone-elses.jsonl", transcript, 0)
		if got := s.userTurns("ws-in"); got != 0 {
			t.Fatalf("userTurns from another conversation = %d, want 0", got)
		}
		writeTranscript(t, s, "ws-in", f.ClaudeSessionID+".jsonl", transcript, 0)
		if got := s.userTurns("ws-in"); got != 1 {
			t.Errorf("userTurns = %d, want 1", got)
		}
	})
}

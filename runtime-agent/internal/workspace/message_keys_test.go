package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAMessageKeyIsSentOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewService(t.TempDir())
	// A first send that lands (a staged prompt Claude has recorded since):
	// no tmux is touched, so it succeeds without one.
	s.sendLock("ws-k").staged = &stagedPrompt{content: "<runner_event/>", baseline: 0, at: time.Now()}
	dir := s.claudeConvDir("ws-k")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "c.jsonl"), []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.SendMessageOnce("ws-k", "<runner_event/>", "delivery-1"); err != nil {
		t.Fatalf("first send = %v", err)
	}
	// The repeat sends nothing: with no tmux session, a real send would fail.
	if err := s.SendMessageOnce("ws-k", "<runner_event/>", "delivery-1"); err != nil {
		t.Fatalf("repeat of a sent key = %v, want success without sending", err)
	}
	// Kept on disk, so a new agent (a restart, a box resumed) knows it too.
	again := NewService(s.Root)
	if err := again.SendMessageOnce("ws-k", "<runner_event/>", "delivery-1"); err != nil {
		t.Fatalf("repeat after a restart = %v", err)
	}
	// Another key is another message: it tries, and fails with no session.
	if err := again.SendMessageOnce("ws-k", "<runner_event/>", "delivery-2"); err == nil {
		t.Fatal("a new key wasn't sent")
	}
}

func TestAMessageKeyThatCantBeKeptIsRefused(t *testing.T) {
	s := NewService(t.TempDir())
	for _, key := range []string{"a\nb", strings.Repeat("k", maxMessageKeyLen+1)} {
		if err := s.SendMessageOnce("ws", "hi", key); !errors.Is(err, ErrInvalidMessageKey) {
			t.Errorf("key %q = %v, want ErrInvalidMessageKey", key, err)
		}
	}
}

func TestOnlyTheNewestMessageKeysAreKept(t *testing.T) {
	s := NewService(t.TempDir())
	path := s.messageKeysPath("ws")
	var keys []string
	for i := 0; i < maxMessageKeys; i++ {
		keys = append(keys, "old")
	}
	if err := writeKeysFile(path, strings.Join(keys, "\n")+"\n"); err != nil {
		t.Fatal(err)
	}
	if got := len(readMessageKeys(path)); got != maxMessageKeys {
		t.Fatalf("read %d keys", got)
	}
	s.forgetMessageKeys("ws")
	if readMessageKeys(path) != nil {
		t.Fatal("a forgotten session's keys were kept")
	}
}

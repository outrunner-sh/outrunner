package workspace

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// maxMessageKeys bounds the keys kept per session: a sender retries a key for
// minutes at most, so the newest few hundred are plenty.
const maxMessageKeys = 500

// maxMessageKeyLen bounds one key.
const maxMessageKeyLen = 200

// ErrInvalidMessageKey is a key that can't be kept: too long, or with a line
// break in it.
var ErrInvalidMessageKey = errors.New("invalid message key")

var messageKeysMu sync.Map // workspaceID -> *sync.Mutex

func (s *Service) messageKeysPath(workspaceID string) string {
	return filepath.Join(s.Root, "message-keys", workspaceID)
}

// SendMessageOnce sends content as SendMessage does, once per key: a key this
// session's agent has already accepted answers as sent without sending again.
// The control plane names one for a send it may repeat after not hearing the
// answer (a Mission's events, lib/missions/outbox.ts), so a repeat after a
// restart on its side reaches Claude once. The keys are kept on the box's
// disk, so they outlast the agent restarting and the box pausing. No key,
// SendMessage.
func (s *Service) SendMessageOnce(workspaceID, content, key string) error {
	return s.SendPromptOnce(workspaceID, Prompt{Content: content}, key)
}

// SendPromptOnce is SendMessageOnce for a prompt in a mode (SendPrompt).
func (s *Service) SendPromptOnce(workspaceID string, p Prompt, key string) error {
	if key == "" {
		return s.SendPrompt(workspaceID, p)
	}
	if len(key) > maxMessageKeyLen || strings.ContainsAny(key, "\r\n") {
		return ErrInvalidMessageKey
	}
	mu, _ := messageKeysMu.LoadOrStore(workspaceID, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	path := s.messageKeysPath(workspaceID)
	keys := readMessageKeys(path)
	for _, k := range keys {
		if k == key {
			return nil
		}
	}
	if err := s.SendPrompt(workspaceID, p); err != nil {
		return err
	}
	keys = append(keys, key)
	if len(keys) > maxMessageKeys {
		keys = keys[len(keys)-maxMessageKeys:]
	}
	// Sent either way: a key not kept only means a repeat would send again.
	_ = writeKeysFile(path, strings.Join(keys, "\n")+"\n")
	return nil
}

func readMessageKeys(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var keys []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			keys = append(keys, line)
		}
	}
	return keys
}

func (s *Service) forgetMessageKeys(workspaceID string) {
	_ = os.Remove(s.messageKeysPath(workspaceID))
	messageKeysMu.Delete(workspaceID)
}

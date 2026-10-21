package transcript

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// NewestRollout is the most recently written rollout under a sessions folder.
func NewestRollout(sessions string) string {
	var newest string
	var newestMod time.Time
	_ = filepath.WalkDir(sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasPrefix(d.Name(), "rollout-") || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().After(newestMod) {
			newest, newestMod = path, info.ModTime()
		}
		return nil
	})
	return newest
}

// RolloutMeta is what a rollout's first line, its session_meta, says.
type RolloutMeta struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
	// Timestamp is when the conversation began (RFC 3339).
	Timestamp string `json:"timestamp"`
}

// Started is when the rollout's conversation began; false when its
// session_meta doesn't say, which leaves no way to tell it from an older one.
func (m RolloutMeta) Started() (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, m.Timestamp)
	return t, err == nil
}

func ReadRolloutMeta(path string) (RolloutMeta, error) {
	file, err := os.Open(path)
	if err != nil {
		return RolloutMeta{}, err
	}
	defer file.Close()
	line, err := bufio.NewReader(file).ReadBytes('\n')
	if err != nil {
		return RolloutMeta{}, err // not even a whole first line yet
	}
	var first struct {
		Type    string      `json:"type"`
		Payload RolloutMeta `json:"payload"`
	}
	if err := json.Unmarshal(line, &first); err != nil || first.Type != "session_meta" {
		return RolloutMeta{}, err
	}
	return first.Payload, nil
}

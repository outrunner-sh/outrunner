package codex

import (
	"encoding/json"
	"strings"
)

// UserPrompt reads the canonical user event for the rollout's history mode.
// Paginated history records UserMessage completions instead of user_message;
// response_item user messages also contain injected context and must be skipped.
func UserPrompt(payload json.RawMessage, paginated bool) (string, bool) {
	var event struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Item    struct {
			Type    string        `json:"type"`
			Content []contentPart `json:"content"`
		} `json:"item"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return "", false
	}
	if !paginated {
		return event.Message, event.Type == "user_message"
	}
	if event.Type != "item_completed" || event.Item.Type != "UserMessage" {
		return "", false
	}
	var parts []string
	for _, part := range event.Item.Content {
		if part.Type == "text" {
			parts = append(parts, part.Text)
		}
	}
	return strings.Join(parts, "\n"), true
}

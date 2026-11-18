package workspace

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"

	"runtime-agent/internal/protocol"
)

// maxSubagentsBytes bounds a session's subagents, which ride on Claude's
// command line.
const maxSubagentsBytes = 64 << 10

var subagentName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func (s *Service) subagentsPath(workspaceID string) string {
	return filepath.Join(s.Root, "subagents", workspaceID+".json")
}

// ValidSubagents accepts subagents a session can take, so a caller can check
// them before changing anything else.
func ValidSubagents(agents map[string]protocol.Subagent) error {
	for name, agent := range agents {
		if !subagentName.MatchString(name) {
			return fmt.Errorf("%w: %q isn't a subagent's name", ErrInvalidEnvironment, name)
		}
		if agent.Description == "" || agent.Prompt == "" {
			return fmt.Errorf("%w: subagent %s needs a description and a prompt", ErrInvalidEnvironment, name)
		}
		switch agent.Model {
		case "", "sonnet", "opus", "haiku", "inherit":
		default:
			return fmt.Errorf("%w: subagent %s's model is sonnet, opus, haiku or inherit", ErrInvalidEnvironment, name)
		}
	}
	data, err := json.Marshal(agents)
	if err != nil || len(data) > maxSubagentsBytes {
		return fmt.Errorf("%w: subagents too large", ErrInvalidEnvironment)
	}
	return nil
}

// SetSubagents gives a session its own subagents, replacing any it had; none
// removes them. They apply at its next launch.
func (s *Service) SetSubagents(workspaceID string, agents map[string]protocol.Subagent) error {
	if err := ValidSubagents(agents); err != nil {
		return err
	}
	path := s.subagentsPath(workspaceID)
	if len(agents) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeJSONFile(path, agents, 0o600)
}

// claudeSubagentArgs give a Claude launch the session's subagents; none when
// it has none, or its Claude doesn't take them.
func (s *Service) claudeSubagentArgs(workspaceID string) []string {
	data, err := os.ReadFile(s.subagentsPath(s.owner(workspaceID)))
	if err != nil || len(data) == 0 {
		return nil
	}
	if !s.claudeTakes("--agents") {
		log.Printf("workspace %s: its Claude doesn't take --agents; it starts without its subagents", workspaceID)
		return nil
	}
	return []string{"--agents", string(data)}
}

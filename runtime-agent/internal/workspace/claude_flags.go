package workspace

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"sync"
	"time"
)

// claudeHelp is the `claude --help` of the binary a session launches, read
// once per build of it: an upgrade in place (a new build at the same path)
// is read again.
type claudeHelp struct {
	mu    sync.Mutex
	build string // path, size and modification time of the binary read
	text  string
}

// claudeTakes reports whether the installed Claude Code takes flag. A Claude
// older than one the agent passes stops at once on it ("error: unknown option
// '--effort'"), taking its session with it, so such a flag is left out
// instead. Unknown (no `claude`, or a --help that fails) is yes: the launch
// then fails or not on its own, as it did before the check.
func (s *Service) claudeTakes(flag string) bool {
	help, ok := s.readClaudeHelp()
	if !ok {
		return true
	}
	return regexp.MustCompile(`(^|[^\w-])` + regexp.QuoteMeta(flag) + `($|[^\w-])`).MatchString(help)
}

func (s *Service) readClaudeHelp() (string, bool) {
	path, err := s.lookPath("claude")
	if err != nil {
		return "", false
	}
	info, err := os.Stat(path) // through the symlink npm and Claude's installer put on the PATH
	if err != nil {
		return "", false
	}
	build := fmt.Sprintf("%s:%d:%d", path, info.Size(), info.ModTime().UnixNano())
	h := &s.claudeHelp
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.build == build {
		return h.text, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := s.runCommand(ctx, s.env, "", path, "--help")
	if err != nil {
		return "", false
	}
	h.build, h.text = build, string(out)
	return h.text, true
}

// claudeEffort is the --effort a session launches with: the one it was given,
// or none on a Claude too old to take it, which runs at its model's default.
func (s *Service) claudeEffort(workspaceID, effort string) string {
	if effort == "" || s.claudeTakes("--effort") {
		return effort
	}
	log.Printf("workspace %s: launching without --effort %s: this computer's Claude Code doesn't take it", workspaceID, effort)
	return ""
}

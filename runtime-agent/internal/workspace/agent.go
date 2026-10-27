package workspace

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// agent is the coding agent a workspace's tmux session runs. The engine around
// it — the worktree, tmux, the readiness wait, prompt delivery, model switches
// — is the same for every agent; what differs is here: how the agent is
// launched, how its screen reads, and where it keeps its conversation.
type agent interface {
	// prepare readies what a launch needs beyond its argv, or says why the
	// session can't launch at all. It runs before a relaunch kills the old
	// session, so a launch bound to fail leaves a running one as it was.
	prepare(ctx context.Context, workspaceID string) error
	// command is the argv that (re)launches a workspace's session in its
	// worktree, continuing its conversation when resume is set.
	command(workspaceID, worktree string, resume bool) []string
	// env is the session's environment: the agent's own (Service.env) and
	// whatever the agent needs on top of it.
	env(anthropicToken string) []string
	// isComposer reports whether a pane shows the agent's prompt box, ready
	// for a prompt.
	isComposer(pane string) bool
	// startupKey is the key that moves a screen shown before the prompt box
	// (a first run's, a folder-trust question) toward it, or "" to press
	// nothing: a key pressed into a screen not understood could mean "No".
	startupKey(pane string) string
	// isBusy reports whether a pane shows a turn in progress, which a
	// relaunch would cut off.
	isBusy(pane string) bool
	// awaitsAnswer reports whether a pane shows a menu instead of the prompt
	// box (a question, a permission prompt), where a typed prompt would be
	// read as a choice.
	awaitsAnswer(pane string) bool
	// sessionLog is the session's conversation in Claude's JSONL record shape
	// (what conversation.Watcher reads), or "" until there is one.
	sessionLog(workspaceID string) string
	// userTurns counts the prompts the agent has recorded, so a send can tell
	// that its prompt landed.
	userTurns(workspaceID string) int
	// exited is the error for a session that ended as soon as it started,
	// saying where to see why.
	exited(folder string) error
}

// errExitedAtStart is waitReady's report of a session gone before its prompt
// box showed; the agent's exited turns it into what the user is told.
var errExitedAtStart = errors.New("the agent exited as soon as it started")

// The agents a session can run, as its facts (and the protocol) name them.
const (
	AgentClaude = "claude"
	AgentCodex  = "codex"
)

// ValidAgent accepts an agent a create may name; empty is Claude.
func ValidAgent(name string) bool {
	return name == "" || name == AgentClaude || name == AgentCodex
}

// Agents lists the agents this computer can run a session on: Claude always
// (a computer without it says so when a session starts), Codex when its CLI
// is installed and the engine is the one that runs it: the jcode engine runs
// its own sessions, whatever agent a create names.
func (s *Service) Agents() []string {
	agents := []string{AgentClaude}
	if _, err := s.lookPath("codex"); err == nil && s.jcode == nil {
		agents = append(agents, AgentCodex)
	}
	return agents
}

// ErrAgentUnsupported is a session asked for on an agent this computer's
// engine can't run: made anyway, it would run another agent instead.
var ErrAgentUnsupported = errors.New("this computer's engine can't run that agent")

// CheckAgent refuses an agent a create or restore names that this computer
// can't run: one there is no such agent as, or Codex on the jcode engine.
// Empty is Claude. A Codex CLI that is missing is left to Start, which says
// how to install it.
func (s *Service) CheckAgent(name string) error {
	switch {
	case !ValidAgent(name):
		return fmt.Errorf("unknown agent %q", name)
	case name == AgentCodex && s.jcode != nil:
		return ErrAgentUnsupported
	}
	return nil
}

// agentFor is the agent a workspace's session runs: the one its facts record,
// and Claude for a session from before there was a choice.
func (s *Service) agentFor(workspaceID string) agent {
	f, _ := s.getFacts(workspaceID)
	switch f.Agent {
	case AgentCodex:
		return codexAgent{s}
	default: // AgentClaude, or "" for a session recorded before agents
		return claudeAgent{s}
	}
}

// launchCommand is the argv for (re)launching a workspace's session.
func (s *Service) launchCommand(workspaceID, worktree string, resume bool) []string {
	// The project's environment first, then what the user provided in the
	// session (request_secrets), so a value provided wins; innermost, a
	// session's own GitHub token (github.go), which wins over both.
	argv := s.withGitHub(workspaceID, s.agentFor(workspaceID).command(workspaceID, worktree, resume))
	return s.withEnvironment(workspaceID, s.withProvided(workspaceID, argv))
}

// SessionLog returns the path of a workspace's conversation log, in Claude's
// record shape, or "" while there is none yet: the file the conversation
// stream, the Summary and Archive read.
func (s *Service) SessionLog(workspaceID string) string {
	if s.jcode != nil {
		return s.jcode.ConversationLog(workspaceID)
	}
	return s.agentFor(workspaceID).sessionLog(workspaceID)
}

// userTurns counts the user prompts a workspace's agent has recorded.
func (s *Service) userTurns(workspaceID string) int {
	return s.agentFor(workspaceID).userTurns(workspaceID)
}

// keyToward is the key that takes a menu's selection toward the option yes
// picks out: Enter once that option is the selected one (the first line
// selected matches), else the arrow toward it. Empty when the pane doesn't
// show both, since any key could then mean "No".
func keyToward(pane string, selected, yes func(line string) bool) string {
	sel, want := -1, -1
	for i, line := range strings.Split(pane, "\n") {
		if sel < 0 && selected(line) {
			sel = i
		}
		if yes(line) {
			want = i
		}
	}
	switch {
	case sel < 0 || want < 0:
		return ""
	case sel == want:
		return "Enter"
	case want > sel:
		return "Down"
	default:
		return "Up"
	}
}

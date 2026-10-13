package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"runtime-agent/internal/codex"
)

// Agents a workspace can run. A workspace without one (every workspace made
// before Codex) runs Claude Code.
const (
	AgentClaude = "claude"
	AgentCodex  = "codex"
)

// ErrUnknownAgent is a create for an agent this agent doesn't run.
var ErrUnknownAgent = errors.New("unknown agent")

// ErrCodexLocalOnly refuses Codex on a Runtime Computer, which has no Codex
// installed (and no login for it).
var ErrCodexLocalOnly = errors.New("Codex runs only in a session on this Mac")

// The sandbox and approvals a Codex session runs with, until the page can
// answer approvals: Codex's own sandbox lets its commands write in the
// session's worktree (or folder) and nowhere else, with no network, and it
// never stops to ask. That is the isolation a session on the user's Mac needs.
const (
	codexApprovalPolicy = "never"
	codexSandbox        = "workspace-write"
)

// codexEngine runs each Codex workspace as its own `codex app-server`, headless:
// a thread per workspace, a turn per prompt. What Codex does arrives as items,
// written to the workspace's conversation log as the Claude-shaped records the
// rest of the agent (the events stream, the summary) already reads.
type codexEngine struct {
	bin   string
	env   []string
	root  string
	clock func() time.Time

	mu       sync.Mutex
	sessions map[string]*codexSession
}

type codexSession struct {
	client *codex.Client
	thread string

	mu    sync.Mutex // guards model and writes to the log
	model string
}

func newCodexEngine(bin string, env []string, root string) *codexEngine {
	return &codexEngine{bin: bin, env: env, root: root, clock: time.Now, sessions: map[string]*codexSession{}}
}

// codexBin is the Codex the agent runs: the desktop's choice (the Mac's own,
// once it is current enough), else `codex` on PATH.
func codexBin() string {
	if bin := os.Getenv("RUNTIME_CODEX_BIN"); bin != "" {
		return bin
	}
	return "codex"
}

// ConversationLog is where a workspace's conversation is written, outside its
// worktree. It lasts across restarts: a resumed thread appends to it.
func (e *codexEngine) ConversationLog(workspaceID string) string {
	return filepath.Join(e.root, "conversations", workspaceID+".jsonl")
}

// codexStart is what Start needs from the workspace.
type codexStart struct {
	Cwd          string
	Thread       string // empty: a new thread
	Model        string // empty: the login's default
	Instructions string
}

// Start runs the workspace's app server and opens its thread: the one it had,
// resumed, or a new one. It returns the thread and the model it runs, for the
// workspace to remember. A workspace already running is left as it is.
func (e *codexEngine) Start(ctx context.Context, workspaceID string, in codexStart) (thread, model string, err error) {
	e.mu.Lock()
	if s := e.sessions[workspaceID]; s != nil && !closed(s.client) {
		e.mu.Unlock()
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.thread, s.model, nil
	}
	e.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(e.ConversationLog(workspaceID)), 0o755); err != nil {
		return "", "", err
	}
	s := &codexSession{}
	client, err := codex.Start(e.bin, in.Cwd, e.env, codex.Handlers{
		Notification: func(method string, params json.RawMessage) { e.notified(workspaceID, s, method, params) },
		Request:      declineRequests,
	})
	if err != nil {
		return "", "", err
	}
	fail := func(err error) (string, string, error) {
		client.Close()
		return "", "", err
	}
	if err := client.Initialize(ctx, "outrunner", "1"); err != nil {
		return fail(err)
	}
	if in.Model == "" {
		// The login's own default: the model in the user's config.toml may be
		// one this login can't use.
		if in.Model, err = client.DefaultModel(ctx); err != nil {
			return fail(fmt.Errorf("codex models: %w", err))
		}
	}
	opts := codex.ThreadOptions{
		Cwd:                   in.Cwd,
		Model:                 in.Model,
		ApprovalPolicy:        codexApprovalPolicy,
		Sandbox:               codexSandbox,
		DeveloperInstructions: in.Instructions,
	}
	if in.Thread != "" {
		thread, model, err = client.ResumeThread(ctx, in.Thread, opts)
		if err != nil {
			// Its history is gone (Codex's own files were cleared): the session
			// carries on in a new thread rather than not at all.
			thread = ""
		}
	}
	if thread == "" {
		if thread, model, err = client.StartThread(ctx, opts); err != nil {
			return fail(fmt.Errorf("codex thread: %w", err))
		}
	}
	if model == "" {
		model = in.Model
	}
	s.mu.Lock()
	s.client, s.thread, s.model = client, thread, model
	s.mu.Unlock()
	e.mu.Lock()
	e.sessions[workspaceID] = s
	e.mu.Unlock()
	return thread, model, nil
}

// ErrCodexNotRunning is a send to a workspace whose Codex isn't running.
var ErrCodexNotRunning = errors.New("Codex isn't running for this session")

// Send starts a turn with the prompt. model, when set, runs it and every
// turn after.
func (e *codexEngine) Send(ctx context.Context, workspaceID, text, model string) error {
	s := e.session(workspaceID)
	if s == nil {
		return ErrCodexNotRunning
	}
	s.mu.Lock()
	thread := s.thread
	if model != "" {
		s.model = model
	}
	model = s.model
	s.mu.Unlock()
	if _, err := s.client.StartTurn(ctx, thread, text, model); err != nil {
		return fmt.Errorf("codex turn: %w", err)
	}
	return nil
}

// Stop ends the workspace's app server and every command it started.
func (e *codexEngine) Stop(workspaceID string) {
	e.mu.Lock()
	s := e.sessions[workspaceID]
	delete(e.sessions, workspaceID)
	e.mu.Unlock()
	if s != nil {
		s.client.Close()
	}
}

// Active reports whether the workspace's app server is running.
func (e *codexEngine) Active(workspaceID string) bool { return e.session(workspaceID) != nil }

// session is the workspace's running session; one whose server exited is
// dropped, so the next Start runs a new one.
func (e *codexEngine) session(workspaceID string) *codexSession {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.sessions[workspaceID]
	if s != nil && closed(s.client) {
		delete(e.sessions, workspaceID)
		return nil
	}
	return s
}

func closed(c *codex.Client) bool {
	select {
	case <-c.Done():
		return true
	default:
		return false
	}
}

// notified writes what a turn produces to the conversation log as each item
// completes, and why a turn failed.
func (e *codexEngine) notified(workspaceID string, s *codexSession, method string, params json.RawMessage) {
	var p struct {
		Item json.RawMessage `json:"item"`
		Turn struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch method {
	case "item/completed":
		e.append(workspaceID, codex.Records(p.Item, s.model, e.clock())...)
	case "turn/completed":
		if p.Turn.Status == "failed" && p.Turn.Error != nil {
			e.append(workspaceID, codex.ErrorRecord(p.Turn.ID+"-error", p.Turn.Error.Message, e.clock()))
		}
	}
}

func (e *codexEngine) append(workspaceID string, lines ...[]byte) {
	if len(lines) == 0 {
		return
	}
	f, err := os.OpenFile(e.ConversationLog(workspaceID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	for _, line := range lines {
		_, _ = f.Write(line)
	}
}

// declineRequests answers what Codex asks. With approvals set to never it
// shouldn't ask anything; if it does, the answer is no until the page can ask
// the user.
func declineRequests(method string, _ json.RawMessage) (any, *codex.RPCError) {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
		"execCommandApproval", "applyPatchApproval":
		return map[string]string{"decision": "decline"}, nil
	}
	return nil, codex.MethodNotFound
}

// isCodex reports whether the workspace runs Codex.
func (s *Service) isCodex(workspaceID string) bool {
	f, _ := s.getFacts(workspaceID)
	return f.Agent == AgentCodex
}

// startCodex runs a Codex workspace: its app server and thread, and a plain
// shell in a tmux session of the workspace's name, where the page's terminal
// attaches as it does to Claude's. Idempotent, like Start. The caller holds
// the lifecycle lock.
func (s *Service) startCodex(ctx context.Context, workspaceID string) (string, error) {
	if err := s.requireWorktree(workspaceID); err != nil {
		return "", err
	}
	f, _ := s.getFacts(workspaceID)
	worktree := s.worktreePath(workspaceID)
	thread, model, err := s.codex.Start(ctx, workspaceID, codexStart{
		Cwd:          worktree,
		Thread:       f.CodexThreadID,
		Model:        f.Model,
		Instructions: s.orientation(workspaceID, worktree),
	})
	if err != nil {
		return "", err
	}
	if f.CodexThreadID != thread || f.Model != model {
		f.CodexThreadID, f.Model = thread, model
		s.setFacts(workspaceID, f)
	}
	name := sessionName(workspaceID)
	if !s.tmux.HasSession(ctx, name) {
		// The terminal is extra: a session whose shell won't start still runs.
		_ = s.tmux.NewSession(ctx, name, worktree, []string{loginShell(s.env), "-l"}, s.env)
	}
	s.beginSummary(workspaceID, worktree)
	return name, nil
}

// loginShell is the user's shell, from the session environment.
func loginShell(env []string) string {
	for _, kv := range env {
		if shell, ok := strings.CutPrefix(kv, "SHELL="); ok && shell != "" {
			return shell
		}
	}
	return "/bin/zsh"
}

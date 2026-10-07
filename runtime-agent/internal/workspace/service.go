// Package workspace orchestrates everything local to one Claude session on the
// Runtime Computer: its git worktree, its tmux session, and the Claude process.
// This is the agent's core service; the HTTP/WS server is a thin shell over it.
package workspace

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"runtime-agent/internal/cast"
	"runtime-agent/internal/claude"
	"runtime-agent/internal/jcode"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/snapshot"
	"runtime-agent/internal/tmux"
)

// Service holds the on-box layout and the tmux manager. One instance per agent.
type Service struct {
	// Root is the Runtime Computer working area, e.g. /home/runtime.
	Root string
	tmux *tmux.Manager
	env  []string
	// secrets are values that can legitimately appear in the Claude process
	// environment. The HTTP server uses them to redact browser-visible PTY
	// output. Agent control variables never enter env in the first place.
	secrets []string

	mu    sync.Mutex
	facts map[string]workspaceFacts

	// sendLocks serializes prompt delivery per workspace. SendKeys types then
	// submits in separate tmux commands, so concurrent sends on one session
	// could interleave into a single garbled prompt; each workspace gets its own
	// lock (sendMu guards the map itself).
	sendMu    sync.Mutex
	sendLocks map[string]*sendState

	// lifeLocks serializes Create, Start, Resume and Destroy per workspace, so
	// two clients attaching at once get the idempotent answer instead of racing
	// each other to `git worktree add` or `tmux new-session` (lifeMu guards the
	// map). Taken before a send lock, never after.
	lifeMu    sync.Mutex
	lifeLocks map[string]*sync.Mutex

	summariesMu sync.Mutex
	summaries   map[string]*Summary

	// recorders capture each session's terminal to an asciinema cast, started at
	// session start (M4 invariant #3: recording is independent of any browser).
	recordersMu sync.Mutex
	recorders   map[string]*cast.Recorder

	// jcode, when set, runs workspaces as sessions on a jcode api-bridge instead
	// of Claude-in-tmux. nil means the default Claude Code engine. Start, Stop,
	// SessionLog, SessionAlive, and SendMessage branch on it.
	jcode *jcodeEngine

	// DefaultPermissionMode applies when a workspace's recorded facts carry no
	// mode — one created before modes existed, or whose facts file is gone. The
	// desktop shell sets it so that gap can never widen a local session to
	// bypassPermissions on the user's own machine.
	DefaultPermissionMode claude.PermissionMode
}

// UseJcode switches the service to the jcode engine, driving workspaces through
// the given (already connected) harness-API client instead of Claude-in-tmux.
// Called once at construction when RUNTIME_ENGINE=jcode.
func (s *Service) UseJcode(client *jcode.Client) {
	s.jcode = newJcodeEngine(client, s.Root)
}

// workspaceFacts are the per-workspace details Create learns and Start/Resume
// need: the orientation prompt's branches and Claude's permission mode. They are
// kept in memory and in a file under Root, because a local agent restarts every
// time the desktop app does, while its tmux sessions — and the user's work —
// carry on. Start degrades gracefully (base omitted from the orientation) when
// neither copy exists.
type workspaceFacts struct {
	Branch         string                `json:"branch"`
	BaseBranch     string                `json:"baseBranch"`
	PermissionMode claude.PermissionMode `json:"permissionMode,omitempty"`
	// RepoPath is the folder on the user's Mac a local session works on; empty
	// on a Runtime Computer, where worktrees come from the bare mirror.
	RepoPath string `json:"repoPath,omitempty"`
	// InPlace marks a local folder that is not a git repository (or has no
	// commit yet): there is nothing to branch, so Claude works in the folder
	// itself rather than a worktree, and Destroy must never remove it.
	InPlace bool `json:"inPlace,omitempty"`
	// ClaudeSessionID names an in-place session's conversation. Its working
	// directory is the user's folder, not its own, so Claude's project directory
	// for it may hold other sessions' conversations there — or the user's own
	// Claude Code's — and "the newest log" could be any of them. The session is
	// launched with this id and found by it instead.
	ClaudeSessionID string `json:"claudeSessionId,omitempty"`
	// Model is the model the session runs; empty is Claude's own default.
	Model string `json:"model,omitempty"`
	// Gateway, when set, runs the session through it on a key of its own (in
	// the session's gateway file) instead of the user's Claude credential.
	Gateway claude.Gateway `json:"gateway,omitempty"`
	// Name and Title label the session in the desktop's list: the folder's name,
	// and what the user asked for first.
	Name      string `json:"name,omitempty"`
	Title     string `json:"title,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
}

// CreateInput is what Create needs to provision one workspace.
type CreateInput struct {
	WorkspaceID string
	Branch      string
	// BaseBranch is the branch to fork from, without a remote prefix ("main").
	BaseBranch string
	// RepoPath is a folder on this machine to work on; empty uses the mirror.
	// A git folder gets a worktree off it; any other folder is used in place.
	RepoPath       string
	PermissionMode claude.PermissionMode
	// Title labels a local session in the desktop's list.
	Title string
	// Model is the session's --model; empty keeps Claude's default. Callers
	// validate it (claude.ValidModel).
	Model string
}

func NewService(root string) *Service {
	env, secrets := sessionEnvironment(os.Environ())
	return &Service{
		Root:      root,
		tmux:      tmux.New(),
		env:       env,
		secrets:   secrets,
		facts:     map[string]workspaceFacts{},
		sendLocks: map[string]*sendState{},
		lifeLocks: map[string]*sync.Mutex{},
		summaries: map[string]*Summary{},
		recorders: map[string]*cast.Recorder{},
	}
}

// sessionEnvironment keeps only the credentials Claude Code itself supports
// and excludes the Runtime agent's control-plane secret and launch variables.
// This prevents an interactive shell from reading RUNTIME_AGENT_SECRET via
// `env`, while keeping non-sensitive OS settings such as PATH and HOME.
func sessionEnvironment(base []string) ([]string, []string) {
	env := make([]string, 0, len(base))
	secrets := make([]string, 0, 2)
	for _, entry := range base {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "RUNTIME_AGENT_SECRET", "RUNTIME_AGENT_ROOT", "PORT":
			continue
		case "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY":
			if value != "" {
				secrets = append(secrets, value)
			}
		}
		env = append(env, entry)
	}
	return env, secrets
}

// RedactionSecrets returns a defensive copy of values that must not be sent to
// a browser in terminal output.
func (s *Service) RedactionSecrets() []string {
	return append(append([]string(nil), s.secrets...), s.gatewayTokens()...)
}

func sessionName(workspaceID string) string { return "ws-" + workspaceID }

// newSessionID is a random (version 4) UUID, the form `claude --session-id`
// requires.
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("workspace: the OS random source is unavailable: " + err.Error())
	}
	b[6] = b[6]&0x0f | 0x40 // version 4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Service) mirrorPath() string { return filepath.Join(s.Root, "repo.git") }
func (s *Service) factsPath(id string) string {
	return filepath.Join(s.Root, "facts", id+".json")
}

// worktreePath is where a workspace's Claude works: its worktree under Root, or
// for an in-place local session, the user's folder itself.
func (s *Service) worktreePath(id string) string {
	if f, ok := s.getFacts(id); ok && f.InPlace && f.RepoPath != "" {
		return f.RepoPath
	}
	return filepath.Join(s.Root, "workspaces", id)
}

// castDir holds a workspace's terminal cast, kept OUTSIDE the worktree so the
// recording never pollutes the git tree (bundle/patch/changedFiles) it archives.
func (s *Service) castDir(id string) string {
	return filepath.Join(s.Root, "casts", id)
}
func (s *Service) castPath(id string) string {
	return filepath.Join(s.castDir(id), cast.DefaultCastName)
}

// Create provisions the workspace's working directory and records its facts.
// On a Runtime Computer that is a git worktree off the shared bare mirror (the
// mirror itself is provisioned separately). With RepoPath — a folder on the
// user's Mac — a git folder gets a worktree on a new branch off its current
// commit (or the base branch, when one is named), and any other folder is used
// in place. Claude is not started until Start.
func (s *Service) Create(ctx context.Context, in CreateInput) (string, error) {
	if strings.HasPrefix(in.Branch, "-") || strings.HasPrefix(in.BaseBranch, "-") {
		return "", fmt.Errorf("invalid branch name")
	}
	if in.RepoPath != "" && in.PermissionMode == claude.Bypass {
		return "", ErrBypassInFolder
	}
	defer s.lockLifecycle(in.WorkspaceID)()
	facts := workspaceFacts{
		Branch:         in.Branch,
		BaseBranch:     in.BaseBranch,
		PermissionMode: in.PermissionMode,
		Title:          in.Title,
		Model:          in.Model,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}
	// A repeated Create (after a restart) keeps the session's original age, and
	// its conversation.
	prior, existed := s.getFacts(in.WorkspaceID)
	if prior.CreatedAt != "" {
		facts.CreatedAt = prior.CreatedAt
	}
	if facts.Model == "" || facts.Model == prior.Model {
		// A re-Create that names no other model keeps the switch, gateway and
		// all: its key file is still there, and dropping the gateway would run
		// the gateway's model name on the user's own Claude.
		facts.Model, facts.Gateway = prior.Model, prior.Gateway
	} else {
		_ = os.Remove(s.gatewayEnvPath(in.WorkspaceID)) // a different model, on Claude
	}
	if in.RepoPath != "" {
		folder, err := s.inspectFolder(ctx, in.RepoPath)
		if err != nil {
			return "", err
		}
		facts.RepoPath, facts.InPlace, facts.Name = folder.path, !folder.git, filepath.Base(folder.path)
		if facts.BaseBranch == "" {
			facts.BaseBranch = folder.branch // the orientation's target branch
		}
		if facts.InPlace {
			// Only a new session gets an id. One recorded before ids existed
			// keeps finding its conversation as before (the newest log): an id
			// with no transcript behind it would start it afresh, cut off from
			// its history.
			facts.ClaudeSessionID = prior.ClaudeSessionID
			if !existed {
				facts.ClaudeSessionID = newSessionID()
			}
		}
	}
	// Record the facts Start/Resume need, even on the idempotent path below so a
	// re-Create after a restart repopulates them.
	s.setFacts(in.WorkspaceID, facts)

	worktree := s.worktreePath(in.WorkspaceID)
	if facts.InPlace {
		return worktree, nil // the user's own folder
	}
	if _, err := os.Stat(worktree); err == nil {
		return worktree, nil // idempotent
	}
	if facts.RepoPath != "" {
		// The facts are the desktop's list of sessions, so a new local session
		// that could not be made must not stay in it. (A Runtime Computer keeps
		// them for the control plane's retry.)
		err := os.MkdirAll(filepath.Dir(worktree), 0o755)
		if err == nil {
			err = s.addCheckoutWorktree(ctx, facts.RepoPath, worktree, in.Branch, in.BaseBranch)
		}
		if err != nil {
			if !existed {
				s.forgetWorkspace(in.WorkspaceID)
			}
			return "", err
		}
		return worktree, nil
	}
	if err := os.MkdirAll(filepath.Dir(worktree), 0o755); err != nil {
		return "", err
	}
	out, err := exec.CommandContext(ctx, "git", "-C", s.mirrorPath(),
		"worktree", "add", "-b", in.Branch, worktree, "origin/"+in.BaseBranch).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("worktree add: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return worktree, nil
}

// ErrBypassInFolder refuses bypassPermissions for a session in a folder on the
// user's own machine, whoever asks for it: there Claude would run every command
// against their real files, keys and credentials without a prompt.
var ErrBypassInFolder = errors.New("bypassPermissions is not allowed for a session in a folder on this machine")

// permissionMode is the mode a workspace's Claude launches with: the one its
// create asked for, else the agent's default (the desktop shell sets one), else
// bypassPermissions — but only on a Runtime Computer. A session in one of the
// user's folders falls back to acceptEdits instead.
func (s *Service) permissionMode(workspaceID string) claude.PermissionMode {
	f, _ := s.getFacts(workspaceID)
	if f.PermissionMode != "" {
		return f.PermissionMode
	}
	if s.DefaultPermissionMode != "" {
		return s.DefaultPermissionMode
	}
	if f.RepoPath != "" {
		return claude.AcceptEdits
	}
	return claude.Bypass
}

// local reports whether a workspace branches from the user's own checkout.
func (s *Service) local(workspaceID string) bool {
	f, _ := s.getFacts(workspaceID)
	return f.RepoPath != ""
}

// Start makes sure the workspace's Claude session is running, inside a tmux
// session, with the Workspace Summary collector attached. It is idempotent, so
// a client may call it every time it attaches:
//   - a live session is left alone (only the collector is re-armed, which an
//     agent restart loses while tmux keeps Claude running);
//   - a workspace whose conversation exists but whose session is gone (the
//     Mac restarted, or Claude exited) continues that conversation;
//   - otherwise a fresh session starts.
func (s *Service) Start(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	defer s.lockLifecycle(workspaceID)()
	name := sessionName(workspaceID)
	if s.jcode != nil {
		if err := s.jcode.StartSession(ctx, workspaceID, s.worktreePath(workspaceID)); err != nil {
			return "", err
		}
		s.beginSummary(workspaceID, s.worktreePath(workspaceID))
		return name, nil
	}
	worktree := s.worktreePath(workspaceID)
	if s.tmux.HasSession(ctx, name) {
		s.beginSummary(workspaceID, worktree)
		return name, nil // already running
	}
	env := claude.SessionEnv(s.env, anthropicToken)
	cmd := s.launchCommand(workspaceID, worktree, s.SessionLog(workspaceID) != "")
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	s.forgetStagedPrompt(workspaceID) // the old composer went with the old session
	// Record from launch (before the readiness wait) so the cast captures Claude's
	// startup output too.
	s.startRecorder(ctx, workspaceID)
	s.waitClaudeReady(ctx, name, s.local(workspaceID))
	s.beginSummary(workspaceID, worktree)
	return name, nil
}

// waitClaudeReady blocks until Claude's TUI has mounted and can accept a
// submitted prompt, so the workspace isn't reported ready while input is still
// silently dropped during startup. It waits for the composer prompt to render
// and enforces a short floor (the measured input-ready point after launch),
// capped so a slow or unexpected launch can never wedge Start. Returns early if
// ctx is cancelled (the start request disconnected or shutdown began).
//
// acceptTrust answers Claude's folder-trust dialog. Every local worktree is a
// directory Claude has never seen, so without this the first prompt would be
// typed into the dialog. Choosing the checkout in Outrunner is the user's trust
// decision; a Runtime Computer never shows the dialog (deploy pre-seeds it).
func (s *Service) waitClaudeReady(ctx context.Context, name string, acceptTrust bool) {
	const minWait = 2 * time.Second
	const maxWait = 15 * time.Second
	launched := time.Now()
	var lastAnswer time.Time
	for {
		if ctx.Err() != nil || time.Since(launched) >= maxWait {
			return
		}
		pane, err := s.tmux.CapturePane(ctx, name)
		// The dialog is checked first: its "❯ 1. Yes, I trust this folder" line
		// also contains the composer glyph.
		if err == nil && isTrustDialog(pane) {
			// "Yes" is preselected, so Enter accepts. Re-press only after a beat:
			// a just-launched TUI can drop the first key.
			if acceptTrust && time.Since(lastAnswer) >= time.Second {
				_ = s.tmux.SubmitEnter(ctx, name)
				lastAnswer = time.Now()
			}
		} else if err == nil && strings.Contains(pane, "❯") && time.Since(launched) >= minWait {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// isTrustDialog reports whether a pane shows Claude Code's folder-trust prompt,
// in either of the wordings it has shipped with.
func isTrustDialog(pane string) bool {
	return strings.Contains(pane, "trust this folder") ||
		strings.Contains(pane, "trust the files in this folder")
}

// Resume re-launches Claude with --continue after an exit or box restart.
// The Summary collector is (re)started so post-restart activity is folded in.
func (s *Service) Resume(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	defer s.lockLifecycle(workspaceID)()
	return s.relaunch(ctx, workspaceID, anthropicToken, true)
}

var (
	// ErrUnknownWorkspace is a workspace this agent has no record of.
	ErrUnknownWorkspace = errors.New("unknown workspace")
	// ErrModelUnsupported is a model switch on an engine that has none (jcode).
	ErrModelUnsupported = errors.New("this engine cannot switch models")
	// ErrSessionBusy is a switch asked for while Claude is mid-turn: the
	// relaunch would cut the turn off.
	ErrSessionBusy = errors.New("Claude is mid-turn; switch models once it has finished")
)

// ModelChoice is what a session runs: a model, and optionally the gateway and
// key it runs through. Callers validate each part.
type ModelChoice struct {
	Model   string
	Gateway claude.Gateway
	Token   string
}

// SetModel switches a session to another model, or to or from a gateway. It is
// recorded first, so every later launch and resume uses it; a running session
// is then relaunched on it, continuing its conversation (Claude reads all of it
// only at launch). It is refused while Claude is mid-turn, which the relaunch
// would cut off.
func (s *Service) SetModel(ctx context.Context, workspaceID string, choice ModelChoice, anthropicToken string) error {
	if s.jcode != nil {
		return ErrModelUnsupported // jcode's bridge launches its own sessions
	}
	defer s.lockLifecycle(workspaceID)()
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return ErrUnknownWorkspace // never write facts for a workspace never created
	}
	env := ""
	if choice.Gateway != claude.NoGateway {
		env = gatewayEnvFile(choice.Gateway, choice.Token, choice.Model)
	}
	priorEnv := s.readGatewayEnv(workspaceID)
	if f.Model == choice.Model && f.Gateway == choice.Gateway && priorEnv == env {
		return nil
	}
	name := sessionName(workspaceID)
	running := s.tmux.HasSession(ctx, name)
	if running {
		if pane, err := s.tmux.CapturePane(ctx, name); err == nil && claudeIsBusy(pane) {
			return ErrSessionBusy
		}
	}
	if err := s.putGatewayEnv(workspaceID, env); err != nil {
		return err
	}
	prior := f
	f.Model, f.Gateway = choice.Model, choice.Gateway
	s.setFacts(workspaceID, f)
	if !running {
		return nil // the next Start launches on it
	}
	// A dropped request must not stop the relaunch between its kill and its
	// new session.
	ctx = context.WithoutCancel(ctx)
	// Continue only a conversation that exists: before the first prompt there
	// is none, and --continue with nothing to continue exits.
	if _, err := s.relaunch(ctx, workspaceID, anthropicToken, s.SessionLog(workspaceID) != ""); err != nil {
		// Not applied, so not recorded: a retry of the same choice tries again
		// rather than finding it already set, and the next Start uses the old.
		_ = s.putGatewayEnv(workspaceID, priorEnv)
		s.setFacts(workspaceID, prior)
		return err
	}
	return nil
}

// claudeIsBusy reports whether Claude's screen shows a turn in progress: its
// footer offers "esc to interrupt" only then.
func claudeIsBusy(pane string) bool {
	return strings.Contains(pane, "esc to interrupt")
}

// relaunch replaces a workspace's Claude session. Callers hold its lifecycle
// lock.
func (s *Service) relaunch(ctx context.Context, workspaceID, anthropicToken string, resume bool) (string, error) {
	// Hold the send lock across the kill+recreate so an in-flight SendMessage
	// retry loop can't press Enter into the freshly recreated session.
	lock := s.sendLock(workspaceID)
	lock.Lock()
	defer lock.Unlock()
	lock.staged = nil // the composer it was typed into is about to go
	name := sessionName(workspaceID)
	if s.jcode != nil {
		// jcode sessions live on the bridge; StartSession is idempotent and
		// re-attaches Runtime's view. --continue semantics are the bridge's.
		if err := s.jcode.StartSession(ctx, workspaceID, s.worktreePath(workspaceID)); err != nil {
			return "", err
		}
		s.beginSummary(workspaceID, s.worktreePath(workspaceID))
		return name, nil
	}
	_ = s.tmux.KillSession(ctx, name)
	worktree := s.worktreePath(workspaceID)
	env := claude.SessionEnv(s.env, anthropicToken)
	cmd := s.launchCommand(workspaceID, worktree, resume)
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	s.startRecorder(ctx, workspaceID)
	s.waitClaudeReady(ctx, name, s.local(workspaceID))
	s.beginSummary(workspaceID, worktree)
	return name, nil
}

// launchCommand is Claude's argv for (re)launching a workspace's session,
// continuing its conversation when resume is set. An in-place session's
// conversation is named by id: it starts under that id and is resumed by it,
// once its transcript exists, whatever else shares the folder. Any other
// session continues the newest conversation in its own worktree.
func (s *Service) launchCommand(workspaceID, worktree string, resume bool) []string {
	mode, orientation := s.permissionMode(workspaceID), s.orientation(workspaceID, worktree)
	f, _ := s.getFacts(workspaceID)
	var argv []string
	switch {
	case f.ClaudeSessionID != "" && s.SessionLog(workspaceID) != "":
		argv = claude.ResumeCommand(mode, f.ClaudeSessionID, orientation)
	case f.ClaudeSessionID != "":
		argv = claude.SessionCommand(mode, f.ClaudeSessionID, orientation)
	case resume:
		argv = claude.ContinueCommand(mode, orientation)
	default:
		argv = claude.Command(mode, orientation)
	}
	if f.Gateway != claude.NoGateway {
		// The model rides in the gateway file: --model refuses a gateway's names.
		return claude.WithEnvFile(argv, s.gatewayEnvPath(workspaceID))
	}
	return claude.WithModel(argv, f.Model)
}

// orientation builds Claude's orientation prompt for a workspace. It uses the
// facts recorded at Create; if those were lost (box restart before the next
// Create), getFacts returns the zero value and the base branch is empty, so
// claude.Orientation omits the target-branch guidance — a degraded but still
// useful prompt (see claude.Orientation).
func (s *Service) orientation(workspaceID, worktree string) string {
	f, _ := s.getFacts(workspaceID)
	return claude.Orientation(worktree, f.BaseBranch)
}

// setFacts records a workspace's facts in memory and on disk. The file write is
// best-effort: losing it costs a degraded orientation after a restart, and the
// permission mode still falls back to DefaultPermissionMode. It is atomic, so a
// crash mid-write leaves the old facts rather than a torn file: for a local
// session the file is the session (the desktop's list, and an in-place
// session's folder and conversation).
func (s *Service) setFacts(workspaceID string, f workspaceFacts) {
	s.mu.Lock()
	s.facts[workspaceID] = f
	s.mu.Unlock()
	data, err := json.Marshal(f)
	if err != nil {
		return
	}
	path := s.factsPath(workspaceID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	// The temporary name does not end in .json, so a listing never reads it.
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil || os.Rename(tmp, path) != nil {
		_ = os.Remove(tmp)
	}
}

func (s *Service) getFacts(workspaceID string) (workspaceFacts, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f, ok := s.facts[workspaceID]; ok {
		return f, true
	}
	data, err := os.ReadFile(s.factsPath(workspaceID))
	if err != nil {
		return workspaceFacts{}, false
	}
	var f workspaceFacts
	if json.Unmarshal(data, &f) != nil {
		return workspaceFacts{}, false
	}
	s.facts[workspaceID] = f
	return f, true
}

// Stop ends the Claude session and stops the Summary collector, marking the
// summary's endedAt. The Summary itself is retained so a post-stop
// SummaryOf still returns the last-known state.
func (s *Service) Stop(ctx context.Context, workspaceID string) error {
	if s.jcode != nil {
		s.jcode.StopSession(workspaceID)
		s.endSummary(workspaceID)
		return nil
	}
	// Finalize the cast BEFORE killing tmux — the recorder taps the live pane, so
	// the pane must still exist while it drains its tail and closes the file.
	s.stopRecorder(ctx, workspaceID)
	s.endSummary(workspaceID)
	return s.tmux.KillSession(ctx, sessionName(workspaceID))
}

// SendMessage delivers a user prompt to a workspace's agent session. Two engine
// paths: the jcode engine forwards it to the api-bridge; the default Claude/tmux
// engine stages the prompt in Claude's composer and submits it. Sends are
// serialized per workspace so concurrent prompts can't interleave into one.
//
// Delivery is the fiddly part. A freshly-launched Claude accepts the pasted text
// but silently drops the submitting Enter for a few (variable) seconds while its
// first-run startup settles, so a single Enter is unreliable. We paste ONCE
// (never re-paste — that would duplicate the text) and then re-press Enter until
// Claude records the turn in its conversation log on disk — the deterministic
// "the prompt landed" signal, rather than scraping the terminal for it.
//
// "Once" holds across calls too. A send that gives up reports an error, and the
// caller retries — but the text is already in the composer, or has landed since.
// So a retry of the same text only presses Enter again, and succeeds at once if
// the earlier copy was recorded in the meantime.
func (s *Service) SendMessage(workspaceID, content string) error {
	lock := s.sendLock(workspaceID)
	lock.Lock()
	defer lock.Unlock()
	if s.jcode != nil {
		return s.jcode.SendMessage(workspaceID, content)
	}
	// The send lock is held throughout, so a hung tmux must not hold it forever:
	// past the deadline its commands are killed and the next send can proceed.
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	before, retry := lock.takeStaged(content, time.Now())
	switch {
	case retry && s.userTurns(workspaceID) > before:
		return nil // the earlier copy landed after that send gave up
	case !retry:
		before = s.userTurns(workspaceID)
		if err := s.tmux.Paste(ctx, name, content); err != nil {
			return err
		}
	}
	var lastErr error
	for attempt := 0; attempt < submitAttempts && ctx.Err() == nil; attempt++ {
		if err := s.tmux.SubmitEnter(ctx, name); err != nil {
			lastErr = err
		}
		time.Sleep(submitPollInterval)
		if s.userTurns(workspaceID) > before {
			return nil // Claude recorded a new user turn: the prompt was accepted
		}
	}
	// The text is in the composer, unconfirmed: a retry must not paste it again.
	lock.staged = &stagedPrompt{content: content, baseline: before, at: time.Now()}
	if lastErr != nil {
		return lastErr
	}
	// The prompt is staged in the composer but Claude never recorded a user turn.
	// Report the failure so the caller sees a non-2xx and can retry, rather than
	// a 200 for an undelivered prompt.
	return fmt.Errorf("prompt not confirmed delivered after %d attempts", submitAttempts)
}

const (
	submitAttempts     = 20
	submitPollInterval = 400 * time.Millisecond
	// sendTimeout bounds one SendMessage: well past the ~8s of submit attempts.
	sendTimeout = 30 * time.Second
	// stagedRetryWindow is how long the same text counts as a retry of a send
	// that gave up, rather than a new prompt that happens to match it.
	stagedRetryWindow = 10 * time.Minute
)

// sendState is one workspace's prompt delivery: the lock that serializes it,
// and the prompt the last send typed but never saw Claude record.
type sendState struct {
	sync.Mutex
	staged *stagedPrompt
}

// stagedPrompt is text SendMessage pasted and submitted without seeing Claude
// record it: still in the composer, or recorded after the send gave up.
type stagedPrompt struct {
	content  string
	baseline int // user turns recorded before it was pasted
	at       time.Time
}

// takeStaged reports whether content retries the staged prompt — the same text,
// soon enough — and if so the user-turn count from before it was pasted. The
// staged prompt is forgotten either way. Call with the lock held.
func (st *sendState) takeStaged(content string, now time.Time) (baseline int, retry bool) {
	p := st.staged
	st.staged = nil
	if p == nil || p.content != content || now.Sub(p.at) > stagedRetryWindow {
		return 0, false
	}
	return p.baseline, true
}

// forgetStagedPrompt drops a staged prompt once its session is replaced: the
// new Claude's composer is empty, so a retry has to paste again.
func (s *Service) forgetStagedPrompt(workspaceID string) {
	lock := s.sendLock(workspaceID)
	lock.Lock()
	lock.staged = nil
	lock.Unlock()
}

// claudeConvDir is where Claude writes this workspace's conversation JSONL:
// $HOME/.claude/projects/<slug>. It uses os.UserHomeDir() + claudeProjectDir —
// the same derivation as SessionLog and conversationDest — rather than s.Root,
// so it stays correct when HOME and Root differ.
func (s *Service) claudeConvDir(workspaceID string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = s.Root // best-effort fallback if HOME is unavailable
	}
	return claudeProjectDir(home, s.worktreePath(workspaceID))
}

// userTurnCount totals the user messages Claude has recorded across the *.jsonl
// files in dir (0 if it doesn't exist yet). We count user turns specifically
// rather than total bytes so an in-flight assistant reply — which also grows the
// log — can't be mistaken for our prompt being accepted. Each conversation entry
// is one JSON line; parse its `type` field (rather than substring-matching
// `"type":"user"`, which can appear inside an assistant turn's content).
func userTurnCount(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		count += fileUserTurns(filepath.Join(dir, e.Name()))
	}
	return count
}

// fileUserTurns counts the user messages in one conversation file (0 if it
// doesn't exist yet).
func fileUserTurns(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var rec struct {
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(line), &rec) == nil && rec.Type == "user" {
			count++
		}
	}
	return count
}

// userTurns counts the user messages in a workspace's conversation: its own
// transcript when the conversation is named by id (an in-place session, whose
// folder other conversations may share), else every transcript in its worktree's
// project directory.
func (s *Service) userTurns(workspaceID string) int {
	if f, _ := s.getFacts(workspaceID); f.ClaudeSessionID != "" {
		return fileUserTurns(filepath.Join(s.claudeConvDir(workspaceID), f.ClaudeSessionID+".jsonl"))
	}
	return userTurnCount(s.claudeConvDir(workspaceID))
}

// lockLifecycle takes the workspace's lifecycle lock and returns its release,
// for `defer s.lockLifecycle(id)()`.
func (s *Service) lockLifecycle(workspaceID string) (unlock func()) {
	s.lifeMu.Lock()
	lock, ok := s.lifeLocks[workspaceID]
	if !ok {
		lock = &sync.Mutex{}
		s.lifeLocks[workspaceID] = lock
	}
	s.lifeMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

// sendLock returns the per-workspace send state, whose mutex serializes
// SendMessage, creating it on first use.
func (s *Service) sendLock(workspaceID string) *sendState {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	lock, ok := s.sendLocks[workspaceID]
	if !ok {
		lock = &sendState{}
		s.sendLocks[workspaceID] = lock
	}
	return lock
}

// SessionName exposes the tmux session name the PTY handler attaches to.
func (s *Service) SessionName(workspaceID string) string { return sessionName(workspaceID) }

// Archive produces a Workspace Snapshot: it stops the session (finalizing the
// cast and the Summary), captures the conversation, git tree, and Summary as
// immutable artifacts, and uploads them — manifest LAST — through the signed
// URLs the control plane minted. It returns the manifest so Next can cache it.
//
// The worktree is intentionally LEFT IN PLACE: reclaiming it is coupled with
// Restore (a later slice), so archived work stays recoverable until Restore can
// revive it. Archive is idempotent — re-archiving a stopped session simply
// re-captures and re-uploads.
func (s *Service) Archive(ctx context.Context, workspaceID string, req protocol.ArchiveWorkspaceRequest) (*snapshot.Manifest, error) {
	if err := s.Stop(ctx, workspaceID); err != nil {
		return nil, err
	}

	summary := s.SummaryOf(ctx, workspaceID)
	summary.State = "archived" // the Snapshot captures the archived session

	return snapshot.Produce(ctx, snapshot.Input{
		WorkspaceID:      workspaceID,
		Worktree:         s.worktreePath(workspaceID),
		CastPath:         s.castPath(workspaceID),
		ConversationPath: s.SessionLog(workspaceID),
		SessionID:        s.sessionID(workspaceID),
		Summary:          summary,
		ArchivedAt:       req.ArchivedAt,
		Uploads:          req.Uploads,
		ClaudeVersion:    snapshot.ClaudeVersion(ctx),
	})
}

// Restore rebuilds an archived Session from its Snapshot and relaunches Claude
// with `claude --continue`. The agent materializes + VERIFIES the worktree
// before booting Claude (M4 invariant #4); a verification failure returns an
// error and Claude is never started. The box need not be the original one —
// everything is rebuilt from the Snapshot's tree + conversation (portability).
func (s *Service) Restore(ctx context.Context, workspaceID string, req protocol.RestoreWorkspaceRequest) (string, error) {
	if req.SessionID == nil || *req.SessionID == "" {
		return "", fmt.Errorf("cannot restore: snapshot has no Claude session id")
	}
	// The session id becomes a filename under ~/.claude/projects/<slug>/; reject
	// anything that could escape that directory (path separators, traversal).
	if !validSessionID(*req.SessionID) {
		return "", fmt.Errorf("cannot restore: invalid session id %q", *req.SessionID)
	}
	worktree := s.worktreePath(workspaceID)
	convDest, err := s.conversationDest(worktree, *req.SessionID)
	if err != nil {
		return "", err
	}
	if err := snapshot.Materialize(ctx, snapshot.MaterializeInput{
		MirrorPath:       s.mirrorPath(),
		WorktreePath:     worktree,
		Branch:           req.Branch,
		ConversationDest: convDest,
		Downloads:        req.Downloads,
	}); err != nil {
		return "", err
	}
	// Verified — safe to boot Claude. Record the facts the orientation prompt
	// needs, then relaunch with --continue against the restored session.
	s.setFacts(workspaceID, workspaceFacts{Branch: req.Branch, BaseBranch: req.BaseBranch})
	return s.Resume(ctx, workspaceID, "")
}

// validSessionID guards the session id before it is used as a path segment. A
// Claude session id is a plain filename (uuid-like); anything with a path
// separator or traversal is rejected so a malicious manifest can't write outside
// the project directory.
func validSessionID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return !strings.ContainsAny(id, "/\\") && !strings.Contains(id, "..")
}

// conversationDest is where the restored conversation JSONL must be written so
// `claude --continue` finds the archived session: Claude's per-project log path
// for this worktree, named by the session id.
func (s *Service) conversationDest(worktree, sessionID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(claudeProjectDir(home, worktree), sessionID+".jsonl"), nil
}

// sessionID returns the Claude session id for `claude --continue` on Restore —
// the JSONL basename without extension — or nil when Claude never wrote a log.
func (s *Service) sessionID(workspaceID string) *string {
	log := s.SessionLog(workspaceID)
	if log == "" {
		return nil
	}
	id := strings.TrimSuffix(filepath.Base(log), filepath.Ext(log))
	if id == "" {
		return nil
	}
	return &id
}

// startRecorder begins capturing the workspace's tmux pane to its cast file.
// Best-effort: recording must never block a session start, so a failure is
// swallowed (the archive later stages an empty cast if none was produced). Any
// recorder already running for this workspace is finalized first (e.g. a Resume
// after Claude exited without a Stop) so its goroutine + FIFO don't leak.
func (s *Service) startRecorder(ctx context.Context, workspaceID string) {
	s.stopRecorder(ctx, workspaceID)
	// Masked like the browser's terminal: a cast is archived and uploaded.
	rec := cast.NewSessionRecorder(sessionName(workspaceID), s.castDir(workspaceID), cast.Options{Secrets: s.RedactionSecrets()})
	s.recordersMu.Lock()
	s.recorders[workspaceID] = rec
	s.recordersMu.Unlock()
	_ = rec.Start(ctx)
}

// stopRecorder finalizes and drops the workspace's recorder. Idempotent.
func (s *Service) stopRecorder(ctx context.Context, workspaceID string) {
	s.recordersMu.Lock()
	rec := s.recorders[workspaceID]
	delete(s.recorders, workspaceID)
	s.recordersMu.Unlock()
	if rec != nil {
		_ = rec.Stop(ctx)
	}
}

// SessionAlive reports whether the workspace's tmux session (and therefore its
// Claude process) is still running. The PTY handler uses this to tell a client
// *detach* (the tmux attach client EOFs, but Claude keeps running) apart from a
// real process *exit* — only the latter should surface as an exit to the UI.
func (s *Service) SessionAlive(ctx context.Context, workspaceID string) bool {
	if s.jcode != nil {
		return s.jcode.Active(workspaceID)
	}
	return s.tmux.HasSession(ctx, sessionName(workspaceID))
}

// Destroy stops the Claude session and removes its worktree from the repository
// it belongs to. Unlike Archive, this is terminal: the persisted Workspace row
// is marked destroyed by the control plane and a future workspace receives a
// new branch/worktree. The operation is idempotent for a worktree already
// removed by an earlier request. The branch itself is kept: in a local checkout
// it may hold commits that were never pushed.
func (s *Service) Destroy(ctx context.Context, workspaceID string) error {
	defer s.lockLifecycle(workspaceID)()
	_ = s.Stop(ctx, workspaceID)
	// An in-place session's directory is the user's own folder: forget the
	// session, never touch the files.
	if f, ok := s.getFacts(workspaceID); ok && f.InPlace {
		s.forgetWorkspace(workspaceID)
		return nil
	}
	worktree := s.worktreePath(workspaceID)
	if _, err := os.Stat(worktree); os.IsNotExist(err) {
		s.forgetWorkspace(workspaceID)
		return nil
	}
	if _, err := s.git(ctx, s.worktreeRepo(ctx, worktree), "worktree", "remove", "--force", worktree); err != nil {
		return fmt.Errorf("worktree remove: %w", err)
	}
	s.forgetWorkspace(workspaceID)
	return nil
}

func (s *Service) forgetWorkspace(workspaceID string) {
	s.mu.Lock()
	delete(s.facts, workspaceID)
	s.mu.Unlock()
	_ = os.Remove(s.factsPath(workspaceID))
	_ = os.Remove(s.gatewayEnvPath(workspaceID))
	s.summariesMu.Lock()
	delete(s.summaries, workspaceID)
	s.summariesMu.Unlock()
	s.recordersMu.Lock()
	delete(s.recorders, workspaceID)
	s.recordersMu.Unlock()
}

// SessionLog returns the current Claude JSONL path for a workspace, or "" if
// Claude hasn't written anything yet. Claude Code stores per-project logs at
// ~/.claude/projects/<slug>/<sessionId>.jsonl (see claudeSlug). A worktree is
// the session's own, and --continue reuses its file, so "newest jsonl" ==
// "current session"; an in-place session's conversation is named by id.
func (s *Service) SessionLog(workspaceID string) string {
	if s.jcode != nil {
		return s.jcode.ConversationLog(workspaceID)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := claudeProjectDir(home, s.worktreePath(workspaceID))
	if f, _ := s.getFacts(workspaceID); f.ClaudeSessionID != "" {
		path := filepath.Join(dir, f.ClaudeSessionID+".jsonl")
		if _, err := os.Stat(path); err != nil {
			return ""
		}
		return path
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var newest string
	var newestMod time.Time
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newestMod) {
			newestMod = info.ModTime()
			newest = filepath.Join(dir, e.Name())
		}
	}
	return newest
}

// claudeProjectDir is the directory Claude Code keeps a working directory's
// conversation logs in. Claude names it after its real working directory, so
// symlinks are resolved first: on macOS /var and /tmp live under /private, and
// a symlinked checkout or home is common. A path that does not exist yet is
// used as given.
func claudeProjectDir(home, worktree string) string {
	if resolved, err := filepath.EvalSymlinks(worktree); err == nil {
		worktree = resolved
	}
	return filepath.Join(home, ".claude", "projects", claudeSlug(worktree))
}

// claudeSlug encodes a filesystem path the way Claude Code names its
// per-project JSONL directory (read from Claude Code 2.1's bundle). It runs
// `path.replace(/[^a-zA-Z0-9]/g, "-")` on a JavaScript string, so the unit is a
// UTF-16 code unit, not a byte or a rune: "é" becomes one '-', an emoji two.
// A slug over claudeSlugMax units is cut there and suffixed with '-' and the
// base-36 absolute value of the path's 32-bit Java-style string hash.
func claudeSlug(path string) string {
	units := utf16.Encode([]rune(path))
	b := make([]byte, len(units))
	var hash int32 // (h<<5)-h+c|0 in JavaScript: wraps exactly like int32
	for i, u := range units {
		hash = hash*31 + int32(u)
		if u >= 'a' && u <= 'z' || u >= 'A' && u <= 'Z' || u >= '0' && u <= '9' {
			b[i] = byte(u)
		} else {
			b[i] = '-'
		}
	}
	if len(b) <= claudeSlugMax {
		return string(b)
	}
	abs := int64(hash)
	if abs < 0 {
		abs = -abs
	}
	return string(b[:claudeSlugMax]) + "-" + strconv.FormatInt(abs, 36)
}

// claudeSlugMax is the longest slug Claude Code keeps whole.
const claudeSlugMax = 200

// beginSummary creates (or refreshes) the Workspace Summary collector for a
// workspace. Called from Start and Resume. Safe to call twice — the collector
// itself guards against re-launch.
func (s *Service) beginSummary(workspaceID, worktree string) {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	if !ok {
		sum = newSummary(workspaceID, worktree)
		s.summaries[workspaceID] = sum
	}
	s.summariesMu.Unlock()
	sum.start(func() string { return s.SessionLog(workspaceID) })
}

// endSummary stops the collector and marks the session as ended. The Summary
// stays in the map so post-stop SummaryOf still returns the last-known state.
func (s *Service) endSummary(workspaceID string) {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	s.summariesMu.Unlock()
	if !ok {
		return
	}
	sum.stop()
}

// SummaryOf returns the current WorkspaceSummary for a workspace. If Start
// hasn't been called yet, returns a "starting" placeholder with best-effort
// git stats — the shape stays stable for every consumer.
func (s *Service) SummaryOf(ctx context.Context, workspaceID string) protocol.WorkspaceSummary {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	s.summariesMu.Unlock()
	if !ok {
		return startingSummary(s.worktreePath(workspaceID))
	}
	return sum.Snapshot(ctx)
}

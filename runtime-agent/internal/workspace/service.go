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
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"runtime-agent/internal/ask"
	"runtime-agent/internal/cast"
	"runtime-agent/internal/claude"
	"runtime-agent/internal/codex"
	"runtime-agent/internal/desktop"
	"runtime-agent/internal/gitcred"
	"runtime-agent/internal/jcode"
	"runtime-agent/internal/media"
	"runtime-agent/internal/preview"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/redact"
	"runtime-agent/internal/snapshot"
	"runtime-agent/internal/tmux"
	"runtime-agent/internal/transcript"
)

// Sessions is the tmux surface the service drives. ListSessions is part of the
// contract because activity recovery must see every live workspace session.
type Sessions interface {
	NewSession(ctx context.Context, name, workdir string, command []string, env []string) error
	HideStatus(ctx context.Context, name string)
	HasSession(ctx context.Context, name string) bool
	ListSessions(ctx context.Context) ([]string, error)
	SessionExists(ctx context.Context, name string) (bool, error)
	KillSession(ctx context.Context, name string) error
	Paste(ctx context.Context, name, text string) error
	SubmitEnter(ctx context.Context, name string) error
	SendKey(ctx context.Context, name, key string) error
	SendKeys(ctx context.Context, name string, keys ...string) error
	CapturePane(ctx context.Context, name string) (string, error)
	CapturePaneStyled(ctx context.Context, name string) (string, error)
}

type unknownActivityMarker struct {
	Since      time.Time `json:"since"`
	LifetimeID string    `json:"lifetimeId"`
}

// Service holds the on-box layout and the tmux manager. One instance per agent.
type Service struct {
	// Root is the Runtime Computer working area, e.g. /home/runtime.
	Root string
	tmux Sessions
	env  []string
	// secrets are values that can legitimately appear in the Claude process
	// environment. The HTTP server uses them to redact browser-visible PTY
	// output. Agent control variables never enter env in the first place.
	secrets []string

	mu            sync.Mutex
	facts         map[string]workspaceFacts
	journalMu     sync.Mutex
	journalCopies map[string]journalCopy

	activityMu                    sync.Mutex
	activityUnknownSince          time.Time
	activityUnknownReason         string
	activityUnknownLogged         time.Time
	activityUnknownClearAttempted bool
	activityUnknownClearFailed    bool
	lifetimeID                    func() string

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
	lifeLocks map[string]*lifecycleState

	// rolloutClaimMu makes finding a Codex session's rollout and claiming it
	// (codexRollout) one step across sessions.
	rolloutClaimMu sync.Mutex

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

	// lookPath finds an agent's binary (exec.LookPath); tests stand in for a
	// computer with or without it.
	lookPath func(file string) (string, error)
	// runCommand runs a helper an agent needs before a launch (`codex
	// login`); tests stand in for it.
	runCommand func(ctx context.Context, env []string, stdin string, argv ...string) ([]byte, error)
	// claudeHelp is the installed Claude Code's --help, for the flags it
	// takes (claudeTakes).
	claudeHelp claudeHelp

	// factsWriteMu serializes updateFacts' read-modify-writes and deletion.
	factsWriteMu sync.Mutex

	// codexTails translate the running Codex sessions' rollouts.
	codexLogMu   sync.Mutex // serializes all appends to translated conversations
	codexTailsMu sync.Mutex
	codexTails   map[string]*codexTail

	// asks holds the questions sessions are waiting on the user to answer
	// (ask.go).
	asks *ask.Broker
	// secretAsks holds the requests for secrets sessions are waiting on
	// (secrets.go).
	secretAsks *ask.SecretsBroker
	// liveSecrets are values provided while sessions run: terminals and
	// recordings already open mask them from then on (LiveSecrets).
	liveSecrets *redact.Tokens
	// liveMu makes reading the live secrets' sources and setting them one
	// step (refreshLiveSecrets).
	liveMu sync.Mutex
	// gitTokens are the GitHub tokens the control plane gives the sessions,
	// and gitToken the helpers' proof they ask from this box (gitcred.go);
	// nil and empty when it gives none.
	gitTokens *gitcred.Cache
	gitToken  string
	// previews asks the control plane for the sessions' previews
	// (previews.go); nil where it makes none.
	previews *preview.Client
	// media uploads the sessions' screenshots and recordings to the control
	// plane (media.go); nil when it can't take them.
	media *media.Client
	// controlPlane is how the agent reaches the control plane, for the
	// sessions' own commands too (sessiontools.go); nil where it can't.
	controlPlane *gitcred.Client
	// sessionTools is whether the sessions' command is in place.
	sessionTools bool
	// RelayExecutable is this binary, which a session's agent launches as
	// its ask_user relay; empty launches sessions without the tool.
	RelayExecutable string
	// outrunnerCLI is whether the sessions have `outrunner` on their PATH,
	// and are launched saying which session they are (outrunner_cli.go).
	outrunnerCLI bool
	// DesktopToolbox is where the box's desktop is driven from (desktop.go);
	// empty launches sessions without the desktop tools.
	DesktopToolbox string
	// desktopFound is set once the box is found to have a desktop, and
	// desktopNotFoundAt when it was last found not to (desktop.go).
	desktopFound      atomic.Bool
	desktopMu         sync.Mutex
	desktopNotFoundAt time.Time
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
	Harness *HarnessState `json:"harness,omitempty"`
	Branch  string        `json:"branch"`
	// BranchRenamable says Branch is the one Outrunner made up, which the
	// agent may still rename once (rename_branch.go).
	BranchRenamable bool                  `json:"branchRenamable,omitempty"`
	BaseBranch      string                `json:"baseBranch"`
	PermissionMode  claude.PermissionMode `json:"permissionMode,omitempty"`
	// RepoPath is the folder on the user's Mac a local session works on; empty
	// on a Runtime Computer, where worktrees come from the bare mirror.
	RepoPath string `json:"repoPath,omitempty"`
	// InPlace marks a local folder that is not a git repository (or has no
	// commit yet): there is nothing to branch, so Claude works in the folder
	// itself rather than a worktree, and Destroy must never remove it.
	InPlace bool `json:"inPlace,omitempty"`
	// Warmed marks a worktree taken from a ready box's warmed checkout
	// (warm.go): the project's warm hook ran in it already.
	Warmed bool `json:"warmed,omitempty"`
	// Checkouts are a multi-repository session's repositories (checkouts.go);
	// none for a session of one.
	Checkouts []Checkout `json:"checkouts,omitempty"`
	// ClaudeSessionID names an in-place session's conversation. Its working
	// directory is the user's folder, not its own, so Claude's project directory
	// for it may hold other sessions' conversations there — or the user's own
	// Claude Code's — and "the newest log" could be any of them. The session is
	// launched with this id and found by it instead.
	ClaudeSessionID string `json:"claudeSessionId,omitempty"`
	// Agent is the coding agent the session runs (see agentFor); empty is
	// Claude, which every session ran before there was a choice.
	Agent string `json:"agent,omitempty"`
	// CodexSessionID names a Codex session's conversation once Codex has
	// recorded one: it is resumed by it (`codex resume <id>`).
	CodexSessionID string `json:"codexSessionId,omitempty"`
	// CodexRollout is the file Codex records that conversation in, found
	// once (codexRollout) and translated from then on.
	CodexRollout string `json:"codexRollout,omitempty"`
	// CodexHome is the Codex home the session last launched in: where its
	// running Codex writes, whatever credential it has been given since
	// (SetAuth applies at the next launch). Empty before its first launch.
	CodexHome string `json:"codexHome,omitempty"`
	// CodexLaunchedAt is when a Codex session whose rollout isn't found yet
	// was launched: the rollout it begins is no older.
	CodexLaunchedAt string `json:"codexLaunchedAt,omitempty"`
	// CodexPromptedAt is when such a session was first sent a prompt since
	// its launch: Codex begins its rollout then. A worktree several chats
	// share can hold another chat's rollout begun since the launch.
	CodexPromptedAt string `json:"codexPromptedAt,omitempty"`
	// Model is the model the session runs; empty is Claude's own default.
	Model string `json:"model,omitempty"`
	// Gateway, when set, runs the session through it on a key of its own (in
	// the session's gateway file) instead of the user's Claude credential.
	Gateway claude.Gateway `json:"gateway,omitempty"`
	// Effort is the reasoning effort the session runs at (claude.Efforts);
	// empty is its model's own. It is part of the model choice: SetModel
	// replaces both together.
	Effort string `json:"effort,omitempty"`
	// Auth is the kind of the session's own credential (SetAuth), kept in its
	// auth file; empty runs on its agent's own login.
	Auth string `json:"auth,omitempty"`
	// Plan puts the session in plan mode (SendPrompt's ModePlan): launched
	// with --permission-mode plan, Codex read-only, whatever mode it builds
	// in. Kept across launches, as the model is, until a prompt in build
	// mode takes it out.
	Plan bool `json:"plan,omitempty"`
	// Parent is the session a chat belongs to (chats.go): set for every chat
	// but its session's main one, which is the session itself. A chat works
	// in its parent's worktree, with its parent's environment and secrets.
	Parent string `json:"parent,omitempty"`
	// Handoff is what a forked chat's first prompt is sent with: where the
	// conversation it continues is, and its latest turns. Cleared once that
	// prompt lands.
	Handoff string `json:"handoff,omitempty"`
	// SideOf is the chat a side chat asks about: each of its prompts goes
	// with that chat's newest turns.
	SideOf string `json:"sideOf,omitempty"`
	// Rewinds counts the edits that cut the conversation's log short
	// (rewind.go), the last at RewoundAt, where the prompt RewoundUUID
	// began: a stream that read past it reads from there again.
	Rewinds     int    `json:"rewinds,omitempty"`
	RewoundAt   int64  `json:"rewoundAt,omitempty"`
	RewoundUUID string `json:"rewoundUuid,omitempty"`
	// Name and Title label the session in the desktop's list: the folder's name,
	// and what the user asked for first.
	Name      string `json:"name,omitempty"`
	Title     string `json:"title,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
}

// GitUser is the git identity for commits in a workspace.
type GitUser struct {
	Name  string
	Email string
}

// CreateInput is what Create needs to provision one workspace.
type CreateInput struct {
	WorkspaceID string
	Branch      string
	// BranchRenamable says Outrunner made Branch up: the agent may name it
	// once (rename_branch.go). Never on the Mac.
	BranchRenamable bool
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
	// Agent is the coding agent the session runs (ValidAgent); empty is
	// Claude. Recorded at the first Create only.
	Agent string
	// GitUser is the git identity for commits; nil uses the system default.
	GitUser *GitUser
	// Checkouts, when set, make a session of several repositories: a folder
	// of worktrees (checkouts.go). Each base branch is its own; BaseBranch is
	// the first's.
	Checkouts []Checkout
}

func NewService(root string) *Service {
	return NewServiceWithSessions(root, tmux.New())
}

// NewServiceWithSessions constructs a service with the supplied session
// manager. Production uses NewService; callers that compose the runtime-agent
// or exercise its server can inject a manager with deterministic list results.
func NewServiceWithSessions(root string, manager Sessions) *Service {
	env, secrets := sessionEnvironment(os.Environ())
	return &Service{
		Root:        root,
		tmux:        manager,
		lifetimeID:  boxLifetimeID,
		env:         env,
		secrets:     secrets,
		facts:       map[string]workspaceFacts{},
		sendLocks:   map[string]*sendState{},
		lifeLocks:   map[string]*lifecycleState{},
		summaries:   map[string]*Summary{},
		recorders:   map[string]*cast.Recorder{},
		lookPath:    exec.LookPath,
		runCommand:  runCommand,
		codexTails:  map[string]*codexTail{},
		asks:        ask.NewBroker(),
		secretAsks:  ask.NewSecretsBroker(),
		liveSecrets: &redact.Tokens{},
	}
}

// sessionEnvironment keeps only the credentials Claude Code itself supports
// and excludes the Runtime agent's control-plane secret and launch variables.
// This prevents an interactive shell from reading RUNTIME_AGENT_SECRET via
// `env`, while keeping non-sensitive OS settings such as PATH and HOME.
//
// The user's GitHub token (GH_TOKEN) stays, for `gh`, and git is pointed at it
// for github.com only (githubCredentialEnv), so the agent can push its branch.
// A box whose control plane gives it fresh tokens points git at this agent
// instead (UseGitCredential), and keeps GH_TOKEN as the fallback.
func sessionEnvironment(base []string) ([]string, []string) {
	env := make([]string, 0, len(base))
	secrets := make([]string, 0, 2)
	hasGitHub := false
	for _, entry := range base {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "RUNTIME_AGENT_SECRET", "RUNTIME_AGENT_ROOT", "PORT", "RUNTIME_SANDBOX_ID", "OUTRUNNER_APP_URL", "RUNTIME_MEMORY_AUTOSCALING":
			continue
		case "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OUTRUNNER_CODEX_GRANT", "GH_TOKEN":
			if value != "" {
				secrets = append(secrets, value)
				hasGitHub = hasGitHub || key == "GH_TOKEN"
			}
		}
		env = append(env, entry)
	}
	if hasGitHub {
		// Last, so these win over any the box set itself.
		env = append(withoutEnv(env, "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"), githubCredentialEnv...)
	}
	return env, secrets
}

// githubCredentialEnv has git answer github.com's credential prompt with
// $GH_TOKEN, as the environment's config (GIT_CONFIG_COUNT): nothing written
// to the box's .gitconfig, and no other host ever handed the token.
var githubCredentialEnv = []string{
	"GIT_CONFIG_COUNT=1",
	"GIT_CONFIG_KEY_0=credential.https://github.com.helper",
	`GIT_CONFIG_VALUE_0=!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f`,
}

// RedactionSecrets returns a defensive copy of values that must not be sent to
// a browser in terminal output.
func (s *Service) RedactionSecrets() []string {
	secrets := append(append([]string(nil), s.secrets...), s.gatewayFiles().tokens()...)
	secrets = append(append(secrets, s.authSecrets()...), s.envTokens()...)
	secrets = append(append(secrets, s.providedTokens()...), s.credentialTokens()...)
	return append(secrets, agentConfigTokens()...)
}

// refreshLiveSecrets sets the live secrets from their sources: the values
// provided to sessions, and the GitHub tokens handed out. Each source calls
// it after it changes, so whichever runs last sets them all.
func (s *Service) refreshLiveSecrets() {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	s.liveSecrets.Set(append(append(s.providedTokens(), s.credentialTokens()...), s.authSecrets()...))
}

// LiveSecrets are secrets that arrive after a redactor is made: an open
// terminal follows them (redact.Redactor.Follow).
func (s *Service) LiveSecrets() *redact.Tokens { return s.liveSecrets }

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
	f, ok := s.getFacts(id)
	if ok && f.Parent != "" {
		return s.worktreePath(f.Parent) // a chat works in its session's
	}
	if ok && f.InPlace && f.RepoPath != "" {
		return f.RepoPath
	}
	return filepath.Join(s.Root, "workspaces", id)
}

// Worktree is where a workspace's Claude works, for the control plane: a
// restore reports it, as create does, since a session imported from a Mac
// was never created here and has none on record.
func (s *Service) Worktree(id string) string { return s.worktreePath(id) }

// requireWorktree refuses a workspace whose folder is gone: deleted, or never
// created here. tmux given a missing start directory silently starts in $HOME,
// so a page reopening a deleted session would otherwise get Claude running in
// the user's home folder.
func (s *Service) requireWorktree(id string) error {
	if _, err := os.Stat(s.worktreePath(id)); os.IsNotExist(err) {
		return ErrUnknownWorkspace
	}
	return nil
}

// Folder is the folder a workspace's session works in, for its editor to open
// on; ErrUnknownWorkspace when it isn't on this box.
func (s *Service) Folder(id string) (string, error) {
	if err := s.requireWorktree(id); err != nil {
		return "", err
	}
	return s.worktreePath(id), nil
}

// SessionEnv is the environment a session's processes get: the agent's own,
// less its control secret and launch variables (sessionEnvironment). The
// editor starts code-server, and so maybe the tmux server, on it.
func (s *Service) SessionEnv() []string { return append([]string{}, s.env...) }

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
	if len(in.Checkouts) > 0 {
		if in.RepoPath != "" {
			return "", fmt.Errorf("%w: a local session has one folder", ErrInvalidCheckouts)
		}
		if err := ValidCheckouts(in.Checkouts); err != nil {
			return "", err
		}
		in.BaseBranch = in.Checkouts[0].BaseBranch
	}
	defer s.lockLifecycle(in.WorkspaceID)()
	facts := workspaceFacts{
		Branch:          in.Branch,
		BranchRenamable: in.BranchRenamable && in.RepoPath == "",
		BaseBranch:      in.BaseBranch,
		PermissionMode:  in.PermissionMode,
		Title:           in.Title,
		Model:           in.Model,
		Agent:           in.Agent,
		CreatedAt:       time.Now().UTC().Format(time.RFC3339),
	}
	// A repeated Create (after a restart) keeps the session's original age, and
	// its conversation.
	prior, existed := s.getFacts(in.WorkspaceID)
	if prior.CreatedAt != "" {
		facts.CreatedAt = prior.CreatedAt
	}
	// Nor does it ever switch the agent: the session's conversation and
	// credentials are that agent's. A session recorded without one is Claude's.
	if existed {
		facts.Agent = prior.Agent
	}
	facts.CodexSessionID, facts.CodexRollout = prior.CodexSessionID, prior.CodexRollout
	facts.CodexLaunchedAt, facts.Auth, facts.CodexHome = prior.CodexLaunchedAt, prior.Auth, prior.CodexHome
	// A repeated Create (after an agent restart) never switches the model:
	// that is SetModel's, which relaunches the session to match. A session on a
	// gateway keeps it, key file and all — dropping it here would run the
	// gateway's model name on the user's own Claude, and unmask the key of a
	// session still running on it.
	if prior.Model != "" || facts.Model == "" {
		facts.Model, facts.Gateway = prior.Model, prior.Gateway
	}
	// Its effort is SetModel's alone, so a repeated Create keeps it as well,
	// and plan mode is a prompt's (SendPrompt).
	facts.Effort, facts.Plan = prior.Effort, prior.Plan
	facts.Checkouts = in.Checkouts
	if existed {
		// A retry keeps what the first Create recorded (before it made
		// anything): a session never switches between one and several.
		facts.Checkouts = prior.Checkouts
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
			if !existed && facts.Agent != AgentCodex {
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
		branch := in.Branch
		if err == nil {
			branch, err = s.addCheckoutWorktree(ctx, facts.RepoPath, worktree, in.Branch, in.BaseBranch)
		}
		if err != nil {
			if !existed {
				s.forgetWorkspace(in.WorkspaceID)
			}
			return "", err
		}
		if branch != facts.Branch {
			// Numbered, the checkout having the name asked for: the session
			// list shows the branch it's on.
			facts.Branch = branch
			s.setFacts(in.WorkspaceID, facts)
		}
		return worktree, nil
	}
	if err := os.MkdirAll(filepath.Dir(worktree), 0o755); err != nil {
		return "", err
	}
	if len(facts.Checkouts) > 0 {
		// The box's warmed folder, when it was warmed with these repositories
		// (warm.go); otherwise new checkouts.
		if s.adoptWarmCheckouts(ctx, worktree, in.Branch, facts.Checkouts) {
			facts.Warmed = true
			s.setFacts(in.WorkspaceID, facts)
			for _, c := range facts.Checkouts {
				setGitUser(ctx, filepath.Join(worktree, c.Name), in.GitUser)
			}
		} else if err := s.createCheckouts(ctx, worktree, in.Branch, facts.Checkouts, in.GitUser); err != nil {
			return "", err
		}
		return worktree, nil
	}
	// The box's warmed checkout, when it has one for this base (warm.go);
	// otherwise a new worktree.
	if s.adoptWarm(ctx, worktree, in.Branch, in.BaseBranch) {
		facts.Warmed = true
		s.setFacts(in.WorkspaceID, facts)
	} else {
		// A branch that wasn't there before is this add's to take back; one
		// that was (the add fails on it) isn't. The worktree is: it wasn't
		// there (above), and one cut off half way would pass for made.
		ours := s.branchMissing(ctx, s.mirrorPath(), in.Branch)
		out, err := exec.CommandContext(ctx, "git", "-C", s.mirrorPath(),
			"worktree", "add", "-b", in.Branch, worktree, "origin/"+in.BaseBranch).CombinedOutput()
		if err != nil {
			s.undoWorktree(ctx, worktree, in.Branch, ours)
			return "", fmt.Errorf("worktree add: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	setGitUser(ctx, worktree, in.GitUser)
	return worktree, nil
}

// setGitUser configures a checkout's git author so commits are attributed to
// the Outrunner user; nil (or one without both) keeps the system default.
func setGitUser(ctx context.Context, dir string, user *GitUser) {
	if user != nil && user.Name != "" && user.Email != "" {
		_ = exec.CommandContext(ctx, "git", "-C", dir, "config", "user.name", user.Name).Run()
		_ = exec.CommandContext(ctx, "git", "-C", dir, "config", "user.email", user.Email).Run()
	}
}

// ErrBypassInFolder refuses bypassPermissions for a session in a folder on the
// user's own machine, whoever asks for it: there Claude would run every command
// against their real files, keys and credentials without a prompt.
var ErrBypassInFolder = errors.New("bypassPermissions is not allowed for a session in a folder on this machine")

// permissionMode is the mode a workspace's Claude launches with: plan while
// the session is in plan mode, else the one its create asked for, else the agent's default (the desktop shell sets one), else
// bypassPermissions — but only on a Runtime Computer. A session in one of the
// user's folders falls back to acceptEdits instead.
func (s *Service) permissionMode(workspaceID string) claude.PermissionMode {
	if f, _ := s.getFacts(workspaceID); f.Plan {
		return claude.Plan // plan mode, over whatever mode it builds in
	}
	return s.buildMode(workspaceID)
}

// buildMode is the mode a workspace's agent builds in: what it launches with
// out of plan mode, and goes to when a plan is approved.
func (s *Service) buildMode(workspaceID string) claude.PermissionMode {
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
	if _, err := os.Stat(s.harnessUndoPath(workspaceID)); err == nil {
		lock := s.lockSend(workspaceID)
		err := s.recoverHarnessHeld(ctx, workspaceID)
		lock.Unlock()
		if err != nil {
			return "", err
		}
	}
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
		// A session started before the status line was hidden loses it on its
		// next attach rather than its next restart.
		s.tmux.HideStatus(ctx, name)
		// One that outlived the agent that recorded it (a restart, an
		// upgrade) is recorded again, its cast continued.
		s.ensureRecorder(ctx, workspaceID)
		s.beginSummary(workspaceID, worktree)
		return name, nil // already running
	}
	if err := s.requireWorktree(workspaceID); err != nil {
		return "", err
	}
	if err := s.requireKeys(workspaceID); err != nil {
		return "", err
	}
	a := s.agentFor(workspaceID)
	if err := a.prepare(ctx, workspaceID); err != nil {
		return "", err
	}
	s.makeContextDir(ctx, workspaceID, worktree)
	s.makeCanvasDir(workspaceID)
	env := a.env(anthropicToken)
	cmd := s.launchCommand(workspaceID, worktree, s.SessionLog(workspaceID) != "")
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	s.startSetup(workspaceID, worktree, env)
	s.forgetStagedPrompt(workspaceID) // the old composer went with the old session
	// Record from launch (before the readiness wait) so the cast captures Claude's
	// startup output too.
	s.startRecorder(ctx, workspaceID)
	if err := s.waitReady(ctx, a, name); err != nil {
		return "", a.exited(worktree)
	}
	s.beginSummary(workspaceID, worktree)
	return name, nil
}

// waitReady blocks until the agent's TUI has mounted and can accept a
// submitted prompt, so the workspace isn't reported ready while input is still
// silently dropped during startup. It waits for the composer prompt to render
// and enforces a short floor (the measured input-ready point after launch),
// capped so a slow or unexpected launch can never wedge Start. Returns early if
// ctx is cancelled (the start request disconnected or shutdown began).
//
// It answers the screens the agent shows before its prompt box (agent.
// startupKey), Claude's folder-trust dialog among them. Every worktree is a
// directory Claude has never seen, so without this the first prompt would be
// typed into the dialog. Choosing the repository or folder in Outrunner is the
// user's trust decision. A Runtime Computer's seeded config trusts its
// workspaces folder, but Claude Code 2.1.296 asks for each folder inside it
// anyway.
//
// An agent that exits meanwhile (an option its version lacks, a crash, a
// "No" to that dialog) takes its session with it: that is errExitedAtStart,
// rather than a session reported ready that the first prompt then finds gone
// ("tmux paste: no session").
func (s *Service) waitReady(ctx context.Context, a agent, name string) error {
	const minWait = 2 * time.Second
	// Room for a first run's screens (theme, security notes) and the trust
	// dialog, a second apart, on a Claude Code still starting up.
	const maxWait = 20 * time.Second
	launched := time.Now()
	var lastAnswer time.Time
	for ctx.Err() == nil && time.Since(launched) < maxWait {
		if !s.tmux.HasSession(ctx, name) {
			return errExitedAtStart
		}
		pane, err := s.tmux.CapturePane(ctx, name)
		if err == nil && a.isComposer(pane) && time.Since(launched) >= minWait {
			break
		}
		// Re-press only after a beat: a just-launched TUI can drop a key, and
		// the pane must show where the last one moved the selection.
		if err == nil && time.Since(lastAnswer) >= time.Second {
			if key := a.startupKey(pane); key != "" {
				_ = s.tmux.SendKey(ctx, name, key)
				lastAnswer = time.Now()
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
	if ctx.Err() == nil && !s.tmux.HasSession(ctx, name) {
		return errExitedAtStart
	}
	return nil
}

// Resume re-launches Claude with --continue after an exit or box restart.
// The Summary collector is (re)started so post-restart activity is folded in.
func (s *Service) Resume(ctx context.Context, workspaceID, anthropicToken string) (string, error) {
	defer s.lockLifecycle(workspaceID)()
	lock := s.lockSend(workspaceID)
	defer lock.Unlock()
	if err := s.recoverHarnessHeld(ctx, workspaceID); err != nil {
		return "", err
	}
	return s.relaunchHeld(ctx, workspaceID, anthropicToken, true, lock)
}

var (
	// ErrUnknownWorkspace is a workspace this agent has no record of.
	ErrUnknownWorkspace = errors.New("unknown workspace")
	// ErrModelUnsupported is a model switch on an engine that has none (jcode).
	ErrModelUnsupported = errors.New("this engine cannot switch models")
	// ErrGatewayUnsupported is a gateway asked of a Codex session that serves
	// only Claude's API: Codex speaks OpenAI's, which of the gateways only
	// OpenRouter serves (codex.RunsThrough).
	ErrGatewayUnsupported = errors.New("a Codex session runs on OpenAI's models directly, or through OpenRouter, and can't use this gateway")
	// ErrSessionBusy is a switch asked for while Claude is mid-turn: the
	// relaunch would cut the turn off.
	ErrSessionBusy = errors.New("Claude is mid-turn; switch models once it has finished")
	// ErrSessionUnchecked is a switch refused because tmux couldn't say whether
	// the session is running: guessing either way could record a model the
	// session isn't using, or cut a turn off.
	ErrSessionUnchecked = errors.New("couldn't check the session; try the switch again")
)

// Past the point where a dropped request may stop it, a model switch runs on
// deadlines of its own, so a hung tmux can't hold the workspace's locks
// forever: a short one for checking the session, and a separate, full one for
// the relaunch, so slow checks never eat into it and leave the kill without
// its replacement.
const (
	switchCheckTimeout    = 10 * time.Second
	switchRelaunchTimeout = 60 * time.Second // covers the readiness wait with room to spare
)

// ModelChoice is what a session runs: a model, optionally the gateway and key
// it runs through, and the effort it runs at (empty: the model's own).
// Callers validate each part.
type ModelChoice struct {
	Selection json.RawMessage
	Model     string
	Gateway   claude.Gateway
	Token     string
	Effort    string
}

// SetModel switches a session to another model or effort, or to or from a
// gateway. It is
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
	codexSession := f.Agent == AgentCodex
	if codexSession && choice.Gateway != claude.NoGateway && !codex.RunsThrough(choice.Gateway) {
		return ErrGatewayUnsupported
	}
	// The session's key file: Claude's sources it, Codex's home is given the
	// key from it at each launch (prepareCodexHome).
	env := ""
	switch {
	case choice.Gateway == claude.NoGateway:
	case codexSession:
		env = codexGatewayEnvFile(choice.Token)
	default:
		env = gatewayEnvFile(choice.Gateway, choice.Token, choice.Model)
	}
	priorEnv := s.readGatewayEnv(workspaceID)
	if f.Model == choice.Model && f.Gateway == choice.Gateway && f.Effort == choice.Effort && priorEnv == env {
		return s.updateHarnessModel(workspaceID, choice.Selection)
	}
	// Held from the busy check through the relaunch, so no prompt can be sent
	// after Claude looked idle and then be cut off by the kill.
	lock := s.lockSend(workspaceID)
	defer lock.Unlock()
	if err := ctx.Err(); err != nil {
		return err // the request gave up while a prompt was sent: nothing recorded
	}
	// From here the switch runs to the end even if the request drops (a check
	// on a cancelled context would misread a running session as gone, and the
	// relaunch must not stop between its kill and its new session), but within
	// deadlines of its own.
	base := context.WithoutCancel(ctx)
	ctx, cancel := context.WithTimeout(base, switchCheckTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	running, err := s.tmux.SessionExists(ctx, name)
	if err != nil {
		return fmt.Errorf("%w (%v)", ErrSessionUnchecked, err)
	}
	if running {
		pane, err := s.tmux.CapturePane(ctx, name)
		if err != nil {
			// Unread is not idle. Only a session tmux says is gone (Claude
			// exited in between) is safe to switch without a relaunch.
			still, checkErr := s.tmux.SessionExists(ctx, name)
			if checkErr != nil || still {
				return fmt.Errorf("%w (its screen could not be read: %v)", ErrSessionUnchecked, err)
			}
			running = false
		} else if s.agentFor(workspaceID).isBusy(pane) {
			return ErrSessionBusy
		}
	}
	if err := s.gatewayFiles().put(workspaceID, env); err != nil {
		return err
	}
	if codexSession && choice.Gateway == claude.NoGateway {
		// The session's Codex home must not keep a copy of a gateway key no
		// longer the session's; a launch in that home writes it again.
		if err := os.Remove(filepath.Join(s.codexHome(workspaceID), "config.toml")); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	// Only the model, gateway and effort change: a Codex session's tail may
	// record its rollout meanwhile.
	s.updateFacts(workspaceID, func(f *workspaceFacts) {
		f.Model, f.Gateway, f.Effort = choice.Model, choice.Gateway, choice.Effort
	})
	if !running {
		return s.updateHarnessModel(workspaceID, choice.Selection) // the next Start launches on it
	}
	// Continue only a conversation that exists: before the first prompt there
	// is none, and --continue with nothing to continue exits.
	resume := s.SessionLog(workspaceID) != ""
	relaunchCtx, cancelRelaunch := context.WithTimeout(base, switchRelaunchTimeout)
	defer cancelRelaunch()
	if _, err := s.relaunchHeld(relaunchCtx, workspaceID, anthropicToken, resume, lock); err != nil {
		// Not applied, so not recorded: a retry of the same choice tries again
		// rather than finding it already set, and the next Start uses the old.
		_ = s.gatewayFiles().put(workspaceID, priorEnv)
		s.updateFacts(workspaceID, func(now *workspaceFacts) {
			now.Model, now.Gateway, now.Effort = f.Model, f.Gateway, f.Effort
		})
		// The old session was killed before the new one failed to start, so
		// bring Claude back on the model it had: a failed switch must not end
		// a session that was working.
		restoreCtx, cancelRestore := context.WithTimeout(base, switchRelaunchTimeout)
		defer cancelRestore()
		if _, restoreErr := s.relaunchHeld(restoreCtx, workspaceID, anthropicToken, resume, lock); restoreErr != nil {
			return fmt.Errorf("%w; restarting it on its previous model failed too: %v", err, restoreErr)
		}
		return err
	}
	return s.updateHarnessModel(workspaceID, choice.Selection)
}

// relaunch replaces a workspace's Claude session. Callers hold its lifecycle
// lock.
func (s *Service) relaunch(ctx context.Context, workspaceID, anthropicToken string, resume bool) (string, error) {
	// Hold the send lock across the kill+recreate so an in-flight SendMessage
	// retry loop can't press Enter into the freshly recreated session.
	lock := s.lockSend(workspaceID)
	defer lock.Unlock()
	return s.relaunchHeld(ctx, workspaceID, anthropicToken, resume, lock)
}

// relaunchHeld is relaunch for a caller already holding the send lock.
func (s *Service) relaunchHeld(ctx context.Context, workspaceID, anthropicToken string, resume bool, lock *sendState) (string, error) {
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
	if err := s.requireWorktree(workspaceID); err != nil {
		return "", err
	}
	if err := s.requireKeys(workspaceID); err != nil {
		return "", err // before the kill: the running session is left as it is
	}
	a := s.agentFor(workspaceID)
	if err := a.prepare(ctx, workspaceID); err != nil {
		return "", err // likewise
	}
	_ = s.tmux.KillSession(ctx, name)
	worktree := s.worktreePath(workspaceID)
	s.makeContextDir(ctx, workspaceID, worktree)
	s.makeCanvasDir(workspaceID)
	env := a.env(anthropicToken)
	cmd := s.launchCommand(workspaceID, worktree, resume)
	if err := s.tmux.NewSession(ctx, name, worktree, cmd, env); err != nil {
		return "", err
	}
	s.startSetup(workspaceID, worktree, env)
	s.continueRecorder(ctx, workspaceID)
	if err := s.waitReady(ctx, a, name); err != nil {
		return "", a.exited(worktree)
	}
	s.beginSummary(workspaceID, worktree)
	return name, nil
}

// orientation builds Claude's orientation prompt for a workspace. It uses the
// facts recorded at Create; if those were lost (box restart before the next
// Create), getFacts returns the zero value and the base branch is empty, so
// claude.Orientation omits the target-branch guidance — a degraded but still
// useful prompt (see claude.Orientation). A session on another company's
// model gets Outrunner's identity after it (claude.Identity, or Codex's
// codex.Identity); it is rebuilt each launch, so a model switch brings the
// identity in or takes it away. Claude reads it every launch; Codex only when
// its conversation starts (codex.Identity), so a Codex session keeps the
// identity it started with.
func (s *Service) orientation(workspaceID, worktree string) string {
	f, _ := s.getFacts(workspaceID)
	// A session in the user's own folder has no branch of its own.
	branch := claude.BranchChosen
	switch {
	case f.InPlace:
	case s.mayNameBranch(workspaceID, f):
		branch = claude.BranchToName
	case onPlaceholderBranch(worktree):
		branch = claude.BranchPlaceholder
	}
	o := claude.Orientation(worktree, f.BaseBranch, branch)
	if len(f.Checkouts) > 0 {
		o += "\n\n" + checkoutsNote(f.Checkouts, f.Branch)
	}
	if branch == claude.BranchToName {
		o += "\n\n" + branchNameNote(f.Branch)
	}
	if s.desktopReady(workspaceID) {
		o += "\n\n# Desktop\n\n" + desktop.Instructions
	}
	o += "\n\n" + s.environmentNote(workspaceID)
	o += "\n\n" + s.canvasNote(workspaceID)
	switch {
	case !f.Gateway.SpeaksAsOutrunner():
	case f.Agent == AgentCodex:
		o += "\n\n" + codex.Identity()
	default:
		o += "\n\n" + claude.Identity(f.Model)
	}
	if note := s.previewsNote(workspaceID); note != "" {
		o += "\n\n" + note
	}
	if note := s.sessionToolsNote(); note != "" {
		o += "\n\n" + note
	}
	if guide := s.guide(workspaceID); guide != "" {
		o += "\n\n" + guide
	}
	if instructions := s.instructions(workspaceID); instructions != "" {
		o += "\n\n# Project instructions\n\nThe user gave these for every session in this project:\n\n" + instructions
	}
	return o
}

// placeholderBranch is the name Outrunner gives a new session's branch,
// runtime/<time>-<id> (generatedBranch in the web app, localBranch on the Mac):
// a name nobody chose.
var placeholderBranch = regexp.MustCompile(`^runtime/[0-9a-z]+-[0-9a-f]{8}$`)

// onPlaceholderBranch reports whether a worktree is still on that branch: read
// from git each launch, so a branch renamed since (at the user's request)
// isn't called a placeholder.
func onPlaceholderBranch(worktree string) bool {
	if !fileExists(filepath.Join(worktree, ".git")) {
		// A folder of checkouts: they share the branch, so the first's.
		if entries, err := os.ReadDir(worktree); err == nil {
			for _, e := range entries {
				if e.IsDir() && fileExists(filepath.Join(worktree, e.Name(), ".git")) {
					worktree = filepath.Join(worktree, e.Name())
					break
				}
			}
		}
	}
	if worktree == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD").Output()
	return err == nil && placeholderBranch.MatchString(strings.TrimSpace(string(out)))
}

// makeContextDir gives a session's worktree the .context directory the
// orientation tells Claude it has, gitignored, for screenshots and notes. A
// .gitignore of "*" inside ignores everything there, itself included, so none
// of it shows in the session's changes or lands in a commit, and the
// repository's own ignore files are left alone. Best effort: Claude starts
// either way, and makes the directory itself if it needs one.
//
// Left alone: a session in the user's own folder, which isn't Outrunner's to
// add to, and a .context the repository tracks, where a "*" would hide new
// files the project means to commit.
func (s *Service) makeContextDir(ctx context.Context, workspaceID, worktree string) {
	if f, _ := s.getFacts(workspaceID); f.InPlace {
		return
	}
	dir := filepath.Join(worktree, ".context")
	ignore := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(ignore); err == nil {
		return
	}
	if _, err := os.Stat(dir); err == nil {
		if tracked, err := s.git(ctx, worktree, "ls-files", "--", ".context"); err != nil || tracked != "" {
			return
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(ignore, []byte("*\n"), 0o644)
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

// updateFacts changes a workspace's recorded facts in place, reading and
// writing them under one lock, so two changes made at once (a credential set
// while a transcript is found) never undo each other. A workspace with no
// facts is left without: false.
func (s *Service) updateFacts(workspaceID string, change func(*workspaceFacts)) bool {
	s.factsWriteMu.Lock()
	defer s.factsWriteMu.Unlock()
	f, ok := s.getFacts(workspaceID)
	if !ok {
		return false
	}
	change(&f)
	s.setFacts(workspaceID, f)
	return true
}

// requireKeys refuses to launch a session whose gateway key or own
// credential was recorded but whose file is gone.
func (s *Service) requireKeys(workspaceID string) error {
	if err := s.requireGatewayEnv(workspaceID); err != nil {
		return err
	}
	return s.requireAuthEnv(workspaceID)
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
//
// A session's other chats stop with it: they work in its worktree, which an
// archive captures as it is. Stop (and Archive, which calls it) waits for
// an in-flight SetModel or mode-switch relaunch to release the lifecycle
// lock before stopping the session (up to switchRelaunchTimeout).
func (s *Service) Stop(ctx context.Context, workspaceID string) error {
	defer s.lockLifecycle(workspaceID)()
	return s.stopHeld(ctx, workspaceID)
}

// stopHeld requires the lifecycle lock for workspaceID. A session caller
// holds its parent/session lock before listing chats, then takes each child
// lock before recursively stopping it. Callers already holding these locks
// (such as Destroy and endChat) must use this path rather than Stop.
func (s *Service) stopHeld(ctx context.Context, workspaceID string) error {
	for _, key := range s.chatKeys(workspaceID) {
		unlock := s.lockLifecycle(key)
		_ = s.stopHeld(ctx, key)
		unlock()
	}
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
//
// Neither the paste nor an Enter goes into a menu Claude is showing instead of
// its prompt box (a permission question, a first-run screen): there they would
// be read as a choice. That send fails with errAwaitsAnswer for the user to
// answer in the terminal.
func (s *Service) SendMessage(workspaceID, content string) error {
	return s.SendPrompt(workspaceID, Prompt{Content: content})
}

// SendPrompt is SendMessage for a prompt in a mode (plan.go): the session is
// put in the prompt's mode first, and a prompt that answers the agent's plan
// closes its menu first.
func (s *Service) SendPrompt(workspaceID string, p Prompt) error {
	if s.jcode != nil {
		if p.Mode == ModePlan {
			return ErrModeUnsupported
		}
		lock := s.lockSend(workspaceID)
		defer lock.Unlock()
		return s.jcode.SendMessage(workspaceID, p.Content)
	}
	if p.Mode != "" && p.Mode != ModePlan && p.Mode != ModeBuild {
		return fmt.Errorf("unknown mode %q", p.Mode)
	}
	// A switch relaunches the session, which takes its lifecycle lock, taken
	// before the send lock as SetModel takes them. Taken for any prompt that
	// names a mode, not only one that switches as things stand: whether it
	// switches is known only under the send lock, and a prompt ahead of it
	// may switch the session the other way meanwhile. Uncontended, it costs
	// nothing; and it is let go as soon as any switch is done, so the paste
	// (up to sendTimeout) doesn't hold up an attach's Start behind it.
	unlockLifecycle := func() {}
	_, undoErr := os.Stat(s.harnessUndoPath(workspaceID))
	if p.Mode != "" || undoErr == nil {
		unlockLifecycle = s.lockLifecycle(workspaceID)
	}
	defer func() { unlockLifecycle() }()
	lock := s.lockSend(workspaceID)
	defer lock.Unlock()
	if err := s.recoverHarnessHeld(context.Background(), workspaceID); err != nil {
		return err
	}
	if f, _ := s.getFacts(workspaceID); f.Harness != nil && (!f.Harness.Delivered || !f.Harness.Saved) {
		return ErrHarnessConflict
	}
	if p.RequirePlan {
		f, ok := s.getFacts(workspaceID)
		switch {
		case !ok:
			return ErrUnknownWorkspace
		case !f.Plan:
			return ErrNoPlanWaiting
		}
	}
	if p.Dismiss {
		if err := s.dismissHeld(workspaceID); err != nil {
			return err
		}
	}
	if s.switchesMode(workspaceID, p.Mode) {
		if err := s.switchModeHeld(workspaceID, p.Mode == ModePlan, lock); err != nil {
			return err
		}
	}
	// Lifecycle before send, released send-lock-held: nothing waits on the
	// one while holding the other, so letting it go early can't deadlock.
	unlockLifecycle()
	unlockLifecycle = func() {}
	if err := s.deliverHeld(workspaceID, s.promptText(workspaceID, p.Content), lock); err != nil {
		return err
	}
	s.handedOff(workspaceID)
	return nil
}

// promptText is a prompt as the session's agent is given it: as typed, but
// for a Codex session in plan mode, which is told with each prompt that a
// plan is wanted (codex.PlanPreamble).
func (s *Service) promptText(workspaceID, content string) string {
	content = s.chatPromptText(workspaceID, content)
	if f, _ := s.getFacts(workspaceID); f.Plan && f.Agent == AgentCodex {
		return codex.PlanPreamble + content
	}
	return content
}

// deliverHeld pastes a prompt into the agent's prompt box and submits it, for
// a caller holding the send lock.
func (s *Service) deliverHeld(workspaceID, content string, lock *sendState) error {
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
		s.codexPrompted(workspaceID)
		before = s.userTurns(workspaceID)
		if s.awaitingAnswer(ctx, workspaceID, name) {
			return errAwaitsAnswer
		}
		s.clearPromptBox(ctx, workspaceID, name)
		if err := s.tmux.Paste(ctx, name, content); err != nil {
			return err
		}
	}
	var lastErr error
	for attempt := 0; attempt < submitAttempts && ctx.Err() == nil; attempt++ {
		if s.awaitingAnswer(ctx, workspaceID, name) {
			// Keep watching for the turn, which may have landed just before the
			// menu came up, but press nothing into it.
			lastErr = errAwaitsAnswer
		} else if err := s.tmux.SubmitEnter(ctx, name); err != nil {
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
	// clearPasses bounds the reads and clears of a prompt box that won't empty.
	clearPasses = 3
	// clearSettle is how long the box gets to be drawn again after a clear.
	clearSettle = 150 * time.Millisecond
)

// clearPromptBox empties the agent's prompt box of text a send would
// otherwise be typed onto. A stop hands the prompts Claude had queued back to
// its box, unsent: the next prompt was pasted after them and went as one
// ("QUEUED while busySLEEPY"). So was a prompt a failed send left staged
// there, once a different one followed. The box is read off the screen and
// cleared only when it holds text, line by line from wherever the cursor is:
// Ctrl+A, Ctrl+K to empty a line and again to take up the next, Backspace to
// join the one above. None of those does anything on an empty box, unlike
// Escape, which twice opens Claude's rewind menu. A box that can't be read is
// left alone, and one that won't empty is logged and sent to as before.
func (s *Service) clearPromptBox(ctx context.Context, workspaceID, name string) {
	a := s.agentFor(workspaceID)
	for pass := 0; ; pass++ {
		pane, err := s.tmux.CapturePaneStyled(ctx, name)
		if err != nil {
			return
		}
		lines := a.typedLines(pane)
		if lines == 0 {
			return
		}
		if pass == clearPasses {
			log.Printf("workspace %s: its prompt box still holds text after clearing it", workspaceID)
			return
		}
		keys := make([]string, 0, 4*(lines+1))
		for i := 0; i <= lines; i++ {
			keys = append(keys, "C-a", "C-k", "C-k", "BSpace")
		}
		if err := s.tmux.SendKeys(ctx, name, keys...); err != nil {
			return
		}
		time.Sleep(clearSettle)
	}
}

// ErrNotInterrupted is a stop that couldn't be confirmed: the session's screen
// couldn't be read, or still shows the turn running after Escape.
var ErrNotInterrupted = errors.New("couldn't stop the turn; try again")

const (
	// interruptTimeout bounds one Interrupt's tmux commands.
	interruptTimeout = 10 * time.Second
	// interruptSettle is how long a turn has to stop after Escape.
	interruptSettle    = 3 * time.Second
	interruptPollEvery = 200 * time.Millisecond
)

// Interrupt stops the turn a session is running, as Escape does in its
// terminal (Claude Code's and Codex's both), and so a question it waits on.
// Escape is pressed only while the screen shows either, and once: on an idle
// prompt box it does nothing useful, and twice opens Claude's rewind menu. An
// idle session is already stopped. The stop is confirmed by the screen, the
// turn's "esc to interrupt" footer gone, or reported as ErrNotInterrupted.
//
// It takes the send lock, so a stop clicked while a prompt is being delivered
// stops the turn that prompt starts, rather than racing its Enter.
func (s *Service) Interrupt(ctx context.Context, workspaceID string) error {
	if s.jcode != nil {
		return s.jcode.Interrupt(ctx, workspaceID)
	}
	if _, ok := s.getFacts(workspaceID); !ok {
		return ErrUnknownWorkspace
	}
	lock := s.lockSend(workspaceID)
	defer lock.Unlock()
	return s.interruptHeld(ctx, workspaceID)
}

// interruptHeld is Interrupt for a caller holding the send lock.
func (s *Service) interruptHeld(ctx context.Context, workspaceID string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), interruptTimeout)
	defer cancel()
	name := sessionName(workspaceID)
	running, err := s.tmux.SessionExists(ctx, name)
	if err != nil {
		return fmt.Errorf("%w (%v)", ErrNotInterrupted, err)
	}
	if !running {
		return nil // no agent, no turn
	}
	a := s.agentFor(workspaceID)
	stopped := func() (bool, error) {
		pane, err := s.tmux.CapturePane(ctx, name)
		if err != nil {
			return false, err
		}
		return !a.isBusy(pane) && !a.awaitsAnswer(pane), nil
	}
	if idle, err := stopped(); err != nil {
		return fmt.Errorf("%w (its screen could not be read: %v)", ErrNotInterrupted, err)
	} else if idle {
		return nil
	}
	if err := s.tmux.SendKey(ctx, name, "Escape"); err != nil {
		return fmt.Errorf("%w (%v)", ErrNotInterrupted, err)
	}
	deadline := time.Now().Add(interruptSettle)
	for {
		select {
		case <-ctx.Done():
			return ErrNotInterrupted
		case <-time.After(interruptPollEvery):
		}
		if idle, err := stopped(); err == nil && idle {
			if f, _ := s.getFacts(workspaceID); f.Agent == AgentCodex {
				s.codexInterrupted(workspaceID) // Codex records no stop of its own
			}
			return nil
		}
		if time.Now().After(deadline) {
			return ErrNotInterrupted
		}
	}
}

// errAwaitsAnswer is a send held back from a menu Claude is showing.
var errAwaitsAnswer = errors.New("Claude is waiting for an answer in the terminal (a question or a permission prompt). Answer it there, then send again")

// awaitingAnswer reports whether the session shows a menu rather than the
// agent's prompt box. A pane that can't be read doesn't block: the send goes
// ahead as it always did.
func (s *Service) awaitingAnswer(ctx context.Context, workspaceID, name string) bool {
	pane, err := s.tmux.CapturePane(ctx, name)
	return err == nil && s.agentFor(workspaceID).awaitsAnswer(pane)
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
	mu      sync.Mutex
	staged  *stagedPrompt
	owner   *Service
	key     string
	users   int // holders and queued acquisitions, guarded by sendMu
	retired bool
}

func (st *sendState) Unlock() {
	st.mu.Unlock()
	if st.owner == nil {
		return
	}
	s := st.owner
	s.sendMu.Lock()
	st.users--
	if st.retired && st.users == 0 {
		st.staged = nil
		if s.sendLocks[st.key] == st {
			delete(s.sendLocks, st.key)
		}
	}
	s.sendMu.Unlock()
}

type lifecycleState struct {
	sync.Mutex
	users int // holders and queued acquisitions, guarded by lifeMu
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
	lock := s.lockSend(workspaceID)
	lock.staged = nil
	lock.Unlock()
}

// lockLifecycle takes the workspace's lifecycle lock and returns its release,
// for `defer s.lockLifecycle(id)()`.
func (s *Service) lockLifecycle(workspaceID string) (unlock func()) {
	s.lifeMu.Lock()
	lock := s.lifeLocks[workspaceID]
	if lock == nil {
		lock = &lifecycleState{}
		s.lifeLocks[workspaceID] = lock
	}
	lock.users++
	s.lifeMu.Unlock()
	lock.Lock()
	return func() {
		lock.Unlock()
		s.lifeMu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(s.lifeLocks, workspaceID)
		}
		s.lifeMu.Unlock()
	}
}

// lockSend registers holders and waiters before releasing the map lock, so
// retiring a chat cannot give concurrent users different send mutexes.
// The returned state is locked; callers release it with Unlock.
func (s *Service) lockSend(workspaceID string) *sendState {
	s.sendMu.Lock()
	lock := s.sendStateHeld(workspaceID)
	lock.users++
	s.sendMu.Unlock()
	lock.mu.Lock()
	return lock
}

func (s *Service) sendStateHeld(workspaceID string) *sendState {
	lock := s.sendLocks[workspaceID]
	if lock == nil {
		lock = &sendState{owner: s, key: workspaceID}
		s.sendLocks[workspaceID] = lock
	}
	return lock
}

// retireSendState drops staged prompt text after all holders and queued
// acquisitions finish. Lifecycle entries similarly retain only active users.
func (s *Service) retireSendState(workspaceID string) {
	s.sendMu.Lock()
	if lock := s.sendLocks[workspaceID]; lock != nil {
		lock.retired = true
		if lock.users == 0 {
			lock.staged = nil
			delete(s.sendLocks, workspaceID)
		}
	}
	s.sendMu.Unlock()
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
	state, err := s.HarnessSelection(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if state != nil && !state.Saved {
		return nil, fmt.Errorf("retry the harness switch to save its selection before archiving")
	}
	chats, err := s.snapshotChats(workspaceID, req.Chats)
	if err != nil {
		return nil, snapshot.FailureAt("chats", "chat", err)
	}

	if err := s.Stop(ctx, workspaceID); err != nil {
		return nil, snapshot.FailureAt("stop", "", err)
	}
	for _, key := range append([]string{workspaceID}, s.chatKeys(workspaceID)...) {
		if err := s.flushHarnessJournal(key); err != nil {
			return nil, snapshot.FailureAt("chats", "conversation", err)
		}
	}

	summary := s.SummaryOf(ctx, workspaceID)
	summary.State = "archived" // the Snapshot captures the archived session

	f, _ := s.getFacts(workspaceID)

	return snapshot.Produce(ctx, snapshot.Input{
		WorkspaceID:      workspaceID,
		Worktree:         s.worktreePath(workspaceID),
		Branch:           f.Branch,
		Checkouts:        s.snapshotCheckouts(f.Checkouts),
		CastPath:         s.castPath(workspaceID),
		ConversationPath: s.SessionLog(workspaceID),
		SessionID:        s.sessionID(workspaceID),
		RolloutPath:      f.CodexRollout, // a Codex session's, raw
		Summary:          summary,
		ArchivedAt:       req.ArchivedAt,
		Uploads:          req.Uploads,
		ClaudeVersion:    snapshot.ClaudeVersion(ctx),
		Chats:            chats,
	})
}

// Restore rebuilds an archived Session from its Snapshot and relaunches its
// agent on it: Claude with its conversation; Codex resumed by its rollout when
// the Snapshot has one, else afresh, its translated history restored. The
// agent materializes + VERIFIES the worktree before booting the agent (M4
// invariant #4); a verification failure returns an error and the agent is
// never started. The box need not be the original one — everything is
// rebuilt from the Snapshot's tree + conversation (portability).
//
// The session's agent, its credential and its model (nil: its agent's own
// default), which a fresh box has no record of, come with the request and are
// recorded first: where a rollout goes, and the launch after, depend on them.
// The model is req.Model as the caller checked it.
func (s *Service) Restore(ctx context.Context, workspaceID string, req protocol.RestoreWorkspaceRequest, model *ModelChoice) (string, error) {
	codexSession := req.Agent == AgentCodex
	rollout := downloadFor(req.Downloads, "rollout") != ""
	sessionID := ""
	if req.SessionID != nil {
		sessionID = *req.SessionID
	}
	if sessionID == "" && (!codexSession || rollout) {
		return "", fmt.Errorf("cannot restore: snapshot has no session id")
	}
	// The session id becomes a filename (under ~/.claude/projects/<slug>/, or
	// a Codex sessions folder); reject anything that could escape that
	// directory (path separators, traversal).
	if sessionID != "" && !validSessionID(sessionID) {
		return "", fmt.Errorf("cannot restore: invalid session id %q", sessionID)
	}
	var checkouts []Checkout
	for _, r := range req.Repos {
		checkouts = append(checkouts, Checkout{Name: r.Checkout, FullName: r.FullName, BaseBranch: r.BaseBranch})
	}
	if len(checkouts) > 0 {
		if err := ValidCheckouts(checkouts); err != nil {
			return "", err
		}
	}
	s.setFacts(workspaceID, workspaceFacts{Branch: req.Branch, BranchRenamable: req.BranchRenamable, BaseBranch: req.BaseBranch, Agent: req.Agent, Checkouts: checkouts})
	if req.Auth != nil && req.Auth.Kind != AuthNone {
		if err := s.SetAuth(ctx, workspaceID, req.Auth.Kind, req.Auth.Token); err != nil {
			return "", err
		}
	}
	if model != nil {
		// Nothing runs yet, so this only records it for the launch below.
		if err := s.SetModel(ctx, workspaceID, *model, ""); err != nil {
			return "", err
		}
	}
	worktree := s.worktreePath(workspaceID)
	in := snapshot.MaterializeInput{
		MirrorPath:     s.mirrorPath(),
		WorktreePath:   worktree,
		Branch:         req.Branch,
		BundleRef:      req.BundleRef,
		OriginWorktree: req.OriginWorktree,
		Downloads:      req.Downloads,
		Checkouts:      s.snapshotCheckouts(checkouts),
	}
	switch {
	case codexSession:
		// No session id: Codex never recorded a conversation to restore.
		if downloadFor(req.Downloads, "conversation") != "" {
			in.ConversationDest = conversationPath(s.Root, workspaceID)
		}
		if rollout {
			in.RolloutDest = restoredRolloutPath(filepath.Join(s.codexHomeFor(workspaceID), "sessions"), sessionID)
		}
	default:
		convDest, err := s.conversationDest(worktree, sessionID)
		if err != nil {
			return "", err
		}
		in.ConversationDest = convDest
	}
	if err := snapshot.Materialize(ctx, in); err != nil {
		return "", err
	}
	if in.ConversationDest != "" {
		if err := s.restoreHarnessJournal(workspaceID, in.ConversationDest); err != nil {
			return "", err
		}
	}
	if in.RolloutDest != "" {
		// `codex resume` finds it by the id its first line names.
		meta, err := transcript.ReadRolloutMeta(in.RolloutDest)
		if err != nil || meta.ID != sessionID {
			return "", fmt.Errorf("cannot restore: the snapshot's rollout is not session %s", sessionID)
		}
		s.updateFacts(workspaceID, func(f *workspaceFacts) { f.CodexRollout, f.CodexSessionID = in.RolloutDest, sessionID })
	}
	if len(req.Chats) > 0 {
		s.restoreChats(ctx, workspaceID, sessionID, req.Chats)
	}
	// Verified — safe to boot the agent, continuing the restored session.
	return s.Resume(ctx, workspaceID, "")
}

// downloadFor is the download URL a restore gave for an artifact, or "".
func downloadFor(downloads []protocol.RestoreDownload, artifact string) string {
	for _, d := range downloads {
		if d.Artifact == artifact {
			return d.URL
		}
	}
	return ""
}

// restoredRolloutPath is where a restored rollout is filed in a Codex home:
// today's folder, named as Codex names one (rollout-<time>-<id>.jsonl).
func restoredRolloutPath(sessions, sessionID string) string {
	now := time.Now()
	return filepath.Join(sessions, now.Format("2006"), now.Format("01"), now.Format("02"),
		"rollout-"+now.Format("2006-01-02T15-04-05")+"-"+sessionID+".jsonl")
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
	return filepath.Join(transcript.ClaudeProjectDir(home, worktree), sessionID+".jsonl"), nil
}

// sessionID returns the session id Restore resumes by: a Codex session's
// (its rollout's), else Claude's — the JSONL basename without extension — or
// nil when the agent never recorded a conversation.
func (s *Service) sessionID(workspaceID string) *string {
	if f, _ := s.getFacts(workspaceID); f.Harness != nil && f.Agent == AgentClaude && f.ClaudeSessionID != "" {
		return &f.ClaudeSessionID
	}
	if f, _ := s.getFacts(workspaceID); f.Agent == AgentCodex {
		if f.CodexSessionID == "" {
			return nil
		}
		return &f.CodexSessionID
	}
	log := s.nativeLog(workspaceID)
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
	rec := cast.NewSessionRecorder(sessionName(workspaceID), s.castDir(workspaceID), cast.Options{Secrets: s.RedactionSecrets(), Live: s.liveSecrets})
	s.recordersMu.Lock()
	s.recorders[workspaceID] = rec
	s.recordersMu.Unlock()
	_ = rec.Start(ctx)
}

// ensureRecorder records a running session that has no recorder in this
// agent: one that outlived the agent that recorded it. Its cast is continued
// (cast.Recorder.Start), not started over.
func (s *Service) ensureRecorder(ctx context.Context, workspaceID string) {
	s.recordersMu.Lock()
	_, recording := s.recorders[workspaceID]
	s.recordersMu.Unlock()
	if !recording {
		s.startRecorder(ctx, workspaceID)
	}
}

// continueRecorder keeps a workspace's cast going across a relaunch: a recorder
// still running is pointed at the new session, so the cast holds everything
// before the relaunch too. A recorder is started afresh, which truncates the
// cast, only when none is running.
func (s *Service) continueRecorder(ctx context.Context, workspaceID string) {
	s.recordersMu.Lock()
	rec := s.recorders[workspaceID]
	s.recordersMu.Unlock()
	if rec != nil {
		running, err := rec.Rearm(ctx)
		if running && err != nil {
			running, _ = rec.Rearm(ctx) // one more try: tmux can drop a command
		}
		if running {
			// Even when tmux won't pipe the new pane, the cast keeps what it
			// has: starting afresh would erase the session up to the switch.
			return
		}
	}
	s.startRecorder(ctx, workspaceID)
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
	// Its chats first: they work in the worktree about to go.
	for _, key := range s.chatKeys(workspaceID) {
		unlock := s.lockLifecycle(key)
		s.endChat(ctx, key)
		unlock()
	}
	_ = s.stopHeld(ctx, workspaceID)
	// An in-place session's directory is the user's own folder: forget the
	// session, never touch the files.
	if f, ok := s.getFacts(workspaceID); ok && f.InPlace {
		s.forgetWorkspace(workspaceID)
		return nil
	}
	worktree := s.worktreePath(workspaceID)
	if f, _ := s.getFacts(workspaceID); len(f.Checkouts) > 0 {
		// A folder of checkouts: each leaves its own mirror, then the folder.
		for _, c := range f.Checkouts {
			s.removeCheckout(ctx, worktree, c)
		}
		if err := os.RemoveAll(worktree); err != nil {
			return fmt.Errorf("remove the session's folder: %w", err)
		}
		s.forgetWorkspace(workspaceID)
		return nil
	}
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
	s.stopCodexTail(workspaceID)
	f, _ := s.getFacts(workspaceID)
	if f.Agent == AgentCodex {
		_ = os.Remove(conversationPath(s.Root, workspaceID)) // its translation
	}
	chat := f.Parent != ""
	// Prompt-path updates hold factsWriteMu while their file write finishes.
	// Hold it before mu, as updateFacts does, so neither an in-flight write
	// nor getFacts' disk read can resurrect a deleted chat.
	s.factsWriteMu.Lock()
	s.mu.Lock()
	delete(s.facts, workspaceID)
	_ = os.Remove(s.factsPath(workspaceID))
	s.mu.Unlock()
	s.factsWriteMu.Unlock()
	s.retireSendState(workspaceID)
	s.gatewayFiles().remove(workspaceID)
	s.authFiles().remove(workspaceID)
	if !chat {
		// A chat's environment and secrets are its session's, still in use.
		s.removeEnvironment(workspaceID)
		s.removeProvided(workspaceID)
	} else {
		_ = os.Remove(filepath.Join(s.Root, "ask", workspaceID+".settings.json"))
	}
	s.forgetMessageKeys(workspaceID)
	s.forgetAsk(workspaceID)
	s.forgetDesktop(workspaceID)
	s.removeCanvas(workspaceID)
	// A session's own Codex home holds a copy of its key (auth.json).
	_ = os.RemoveAll(s.codexHome(workspaceID))
	s.summariesMu.Lock()
	delete(s.summaries, workspaceID)
	s.summariesMu.Unlock()
	s.recordersMu.Lock()
	delete(s.recorders, workspaceID)
	s.recordersMu.Unlock()
}

// Activity reports the most recent activity in any session on this box, and
// whether Claude is mid-turn in any of them; zero time when no session has a
// summary yet. The third result is true when the complete set of live sessions
// cannot be established, so the server can avoid mistaking its boot for user
// activity. The control plane pauses a box idle long enough.
func (s *Service) Activity() (last time.Time, turnInProgress, unknown bool) {
	// tmux and its Claude processes outlive this Go service. After a runtime-
	// agent restart (including an in-place upgrade), re-arm summaries for live
	// sessions before reporting activity to the box reconciler. Without this,
	// an active turn is forgotten and the fresh server boot time ages into the
	// 15-minute idle cutoff, which pauses the box underneath that turn.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if reason := s.recoverRunningSummaries(ctx); reason != "" {
		// Protect active work when tmux is temporarily unreadable or a live
		// session has lost its persisted facts. Unknown activity is never proof
		// of completed work, regardless of how long the user has been away.
		last, turnInProgress = s.unknownActivity(reason)
		return last, turnInProgress, true
	}
	s.clearUnknownActivity()
	last, turnInProgress = s.summariesActivity()
	return last, turnInProgress, false
}

// recoverRunningSummaries reattaches conversation collectors for tmux
// sessions that survived a runtime-agent restart. Facts are persisted beside
// each worktree, so the session id and summary path can be recovered without
// changing or restarting the user process. A non-empty result explains why
// Activity cannot establish the complete set of live sessions.
func (s *Service) recoverRunningSummaries(ctx context.Context) string {
	if s.jcode != nil {
		return "" // jcode boxes are metered but are not paused by the reconciler.
	}
	names, err := s.tmux.ListSessions(ctx)
	if err != nil {
		return fmt.Sprintf("couldn't list tmux sessions: %v", err)
	}
	unknown := ""
	for _, name := range names {
		id, ok := strings.CutPrefix(name, "ws-")
		if !ok || id == "" {
			continue // editor or another non-workspace tmux session
		}
		if _, ok := s.getFacts(id); !ok {
			if unknown == "" {
				unknown = fmt.Sprintf("live tmux session %q has no persisted workspace facts", name)
			}
			continue
		}
		s.beginSummary(id, s.worktreePath(id))
	}
	return unknown
}

const unknownActivityLogInterval = 10 * time.Minute

// unknownActivity protects unfinished work until live sessions can be observed
// again. Persist its original timestamp for diagnostics across service restarts;
// uncertainty never expires into permission to pause. Warnings are rate-limited.
func (s *Service) unknownActivity(reason string) (time.Time, bool) {
	now := time.Now().UTC()
	knownLast, _ := s.summariesActivity()
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	if s.activityUnknownSince.IsZero() {
		s.activityUnknownClearAttempted = false
		if !s.activityUnknownClearFailed {
			s.activityUnknownSince = s.readUnknownActivitySince()
		}
		if s.activityUnknownSince.IsZero() {
			s.activityUnknownSince = now
			s.writeUnknownActivitySince(s.activityUnknownSince)
		}
	}
	s.activityUnknownReason = reason
	if s.activityUnknownLogged.IsZero() || now.Sub(s.activityUnknownLogged) >= unknownActivityLogInterval {
		age := now.Sub(s.activityUnknownSince).Round(time.Second)
		log.Printf("runtime-agent: activity remains unknown for %s (%s); keeping the box running until work can be confirmed idle", age, s.activityUnknownReason)
		s.activityUnknownLogged = now
	}
	return laterOf(s.activityUnknownSince, knownLast), true
}

func (s *Service) summariesActivity() (last time.Time, turnInProgress bool) {
	s.summariesMu.Lock()
	sums := make([]*Summary, 0, len(s.summaries))
	for _, sum := range s.summaries {
		sums = append(sums, sum)
	}
	s.summariesMu.Unlock()
	for _, sum := range sums {
		at, open := sum.activity()
		if at.After(last) {
			last = at
		}
		turnInProgress = turnInProgress || open
	}
	return last, turnInProgress
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func (s *Service) clearUnknownActivity() {
	s.activityMu.Lock()
	if s.Root != "" && !s.activityUnknownClearAttempted {
		err := os.Remove(s.unknownActivityPath())
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			if !s.activityUnknownClearFailed {
				log.Printf("runtime-agent: couldn't clear persisted unknown activity time: %v", err)
			}
			s.activityUnknownClearFailed = true
		} else {
			s.activityUnknownClearAttempted = true
			s.activityUnknownClearFailed = false
		}
	}
	s.activityUnknownSince = time.Time{}
	s.activityUnknownReason = ""
	s.activityUnknownLogged = time.Time{}
	s.activityMu.Unlock()
}

// Persist the start of an unknown-activity interval so diagnostics retain its
// age across runtime-agent restarts.
func (s *Service) unknownActivityPath() string {
	return filepath.Join(s.Root, "runtime-agent-activity-unknown-since")
}

func (s *Service) readUnknownActivitySince() time.Time {
	if s.Root == "" {
		return time.Time{}
	}
	data, err := os.ReadFile(s.unknownActivityPath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("runtime-agent: couldn't read persisted unknown activity time: %v", err)
		}
		return time.Time{}
	}
	var marker unknownActivityMarker
	decodeErr := json.Unmarshal(data, &marker)
	if decodeErr != nil || marker.Since.IsZero() {
		// A timestamp from the earlier marker format has no container identity;
		// reset it once rather than risk carrying an expired interval into a
		// resumed box.
		if _, legacyErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(data))); legacyErr == nil {
			log.Printf("runtime-agent: persisted unknown activity time has no box lifetime; starting a new protection window")
			return time.Time{}
		}
		if decodeErr != nil {
			log.Printf("runtime-agent: couldn't parse persisted unknown activity time: %v", decodeErr)
		} else {
			log.Printf("runtime-agent: persisted unknown activity time has no timestamp")
		}
		return time.Time{}
	}
	lifetime := s.lifetimeID()
	if lifetime == "" {
		log.Printf("runtime-agent: couldn't validate persisted unknown activity time without a box lifetime id; starting a new protection window")
		return time.Time{}
	}
	if marker.LifetimeID == "" {
		log.Printf("runtime-agent: persisted unknown activity time has no box lifetime id; starting a new protection window")
		return time.Time{}
	}
	if marker.LifetimeID != lifetime {
		log.Printf("runtime-agent: persisted unknown activity time belongs to another box lifetime; starting a new protection window")
		return time.Time{}
	}
	return marker.Since.UTC()
}

// boxLifetimeID combines the kernel boot ID with PID 1's start time when both
// are available. A VM reboot changes the former; a container start on a shared
// host changes the latter. If one source is unavailable, the other still keeps
// the unknown-activity window bounded across runtime-agent restarts. A boot-only
// ID cannot distinguish a container restart on a shared host, so a stale marker
// may still match across that boundary.
func boxLifetimeID() string {
	bootID, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	boot := ""
	if err == nil {
		boot = strings.TrimSpace(string(bootID))
	}
	data, err := os.ReadFile("/proc/1/stat")
	pid1Start := ""
	if err == nil {
		pid1Start = pid1StartTime(string(data))
	}
	return boxLifetimeIDParts(boot, pid1Start)
}

func pid1StartTime(stat string) string {
	close := strings.LastIndex(stat, ")")
	if close < 0 {
		return ""
	}
	fields := strings.Fields(stat[close+1:])
	// After the command name, the first field is stat field 3 (state), so field
	// 22 (starttime) is at index 19.
	if len(fields) <= 19 {
		return ""
	}
	return fields[19]
}

func boxLifetimeIDParts(bootID, pid1Start string) string {
	switch {
	case bootID != "" && pid1Start != "":
		return "boot:" + bootID + ":pid1:" + pid1Start
	case bootID != "":
		return "boot:" + bootID
	case pid1Start != "":
		return "pid1:" + pid1Start
	default:
		return ""
	}
}

func (s *Service) writeUnknownActivitySince(since time.Time) {
	if s.Root == "" {
		return
	}
	lifetime := s.lifetimeID()
	if lifetime == "" {
		log.Printf("runtime-agent: couldn't persist unknown activity time without a box lifetime id")
		return
	}
	marker := unknownActivityMarker{Since: since.UTC(), LifetimeID: lifetime}
	data, err := json.Marshal(marker)
	if err != nil {
		log.Printf("runtime-agent: couldn't encode unknown activity time: %v", err)
		return
	}
	if err := os.WriteFile(s.unknownActivityPath(), data, 0o600); err != nil {
		log.Printf("runtime-agent: couldn't persist unknown activity time: %v", err)
	}
}

// beginSummary creates (or refreshes) the Workspace Summary collector for a
// workspace. Called from Start and Resume. Safe to call twice — the collector
// itself guards against re-launch.
func (s *Service) beginSummary(workspaceID, worktree string) {
	s.summariesMu.Lock()
	sum, ok := s.summaries[workspaceID]
	if !ok {
		f, _ := s.getFacts(workspaceID)
		sum = newSummary(workspaceID, worktree)
		sum.checkouts = checkoutDirs(worktree, f.Checkouts)
		s.summaries[workspaceID] = sum
	}
	s.summariesMu.Unlock()
	if f, _ := s.getFacts(workspaceID); f.Agent == AgentCodex && s.jcode == nil {
		// Before the collector, which reads what the tail writes.
		s.startCodexTail(workspaceID)
	}
	sum.start(func() string { return s.SessionLog(workspaceID) })
}

// endSummary stops the collector and marks the session as ended. The Summary
// stays in the map so post-stop SummaryOf still returns the last-known state.
func (s *Service) endSummary(workspaceID string) {
	s.stopCodexTail(workspaceID)
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
	snap := sum.Snapshot(ctx)
	// A Claude that ended on its own (it crashed, or was quit) leaves a
	// summary that still says running, its last turn perhaps open: its tmux
	// session gone says otherwise. Only when tmux says so: one that couldn't
	// be asked isn't taken for gone. A watcher of the turn (a Mission's,
	// lib/missions/watch.ts) then hears it ended rather than wait for good.
	if snap.State == "running" && s.jcode == nil {
		if exists, err := s.tmux.SessionExists(ctx, sessionName(workspaceID)); err == nil && !exists {
			snap.State = "exited"
		}
	}
	return snap
}

// snapshotCheckouts are a session's checkouts as a Snapshot captures or
// restores them, each with its mirror.
func (s *Service) snapshotCheckouts(checkouts []Checkout) []snapshot.Checkout {
	var out []snapshot.Checkout
	for _, c := range checkouts {
		out = append(out, snapshot.Checkout{Name: c.Name, FullName: c.FullName, BaseBranch: c.BaseBranch, MirrorPath: RepoMirrorPath(s.Root, c.Name)})
	}
	return out
}

func (s *Service) authSecrets() []string {
	tokens := s.authFiles().tokens()
	for _, value := range append([]string(nil), tokens...) {
		if bearer := codex.AccountBearer(value); bearer != "" {
			tokens = append(tokens, bearer)
		}
	}
	return tokens
}

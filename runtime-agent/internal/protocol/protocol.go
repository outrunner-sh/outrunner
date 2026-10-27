// Package protocol mirrors lib/runtime/agent-protocol.ts. The zod schemas on the
// TypeScript side are the source of truth; these structs must stay in sync. The
// shared golden fixtures (lib/runtime/agent-protocol.fixtures.json) are decoded
// by protocol_test.go so the two languages cannot silently drift.
package protocol

import "encoding/json"

// RuntimeTokenClaims is the short-lived token the agent verifies per connection.
type RuntimeTokenClaims struct {
	WorkspaceID string `json:"workspaceId"`
	ProjectID   string `json:"projectId"`
	ComputerID  string `json:"computerId"`
	UserID      string `json:"userId"`
	Exp         int64  `json:"exp"`
}

// PtyClientMessage is a frame from the browser on WS /pty.
// t ∈ {input, resize, ping}.
type PtyClientMessage struct {
	T    string `json:"t"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// Valid enforces the frozen client-frame contract after JSON decoding. It is
// deliberately here (rather than in the WebSocket handler) so any future
// transport shares the same bounds.
func (m PtyClientMessage) Valid() bool {
	switch m.T {
	case "input":
		return true
	case "resize":
		return m.Cols > 0 && m.Cols <= 65535 && m.Rows > 0 && m.Rows <= 65535
	case "ping":
		return true
	default:
		return false
	}
}

// PtyServerMessage is a frame from the agent on WS /pty.
// t ∈ {output, role, exit, pong}.
type PtyServerMessage struct {
	T    string `json:"t"`
	Data string `json:"data,omitempty"`
	// Seq is a pointer, like Writer/Code, so seq 0 (the first output frame)
	// serializes as `"seq":0` instead of being dropped by omitempty. The zod
	// side requires seq on every output frame; a missing seq is rejected as an
	// invalid PTY frame. Non-output frames leave it nil so it stays omitted.
	Seq    *int  `json:"seq,omitempty"`
	Writer *bool `json:"writer,omitempty"`
	Code   *int  `json:"code,omitempty"`
}

// GitUser is the git identity for commits in a workspace.
type GitUser struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// CreateWorkspaceRequest is the control-plane request to provision a workspace.
type CreateWorkspaceRequest struct {
	WorkspaceID  string `json:"workspaceId"`
	RepoFullName string `json:"repoFullName"`
	Branch       string `json:"branch"`
	BaseBranch   string `json:"baseBranch"`
	// RepoPath, when set, is an existing checkout on this machine to branch the
	// worktree from instead of the computer's bare mirror. Only the desktop
	// shell sends it: a local session works in the user's own clone.
	RepoPath string `json:"repoPath,omitempty"`
	// PermissionMode is Claude's --permission-mode. Empty takes the agent's
	// default: bypassPermissions on a Runtime Computer, never for a RepoPath
	// session (which refuses bypassPermissions outright).
	PermissionMode string `json:"permissionMode,omitempty"`
	// Title labels a local session in the desktop's list (the first prompt).
	Title string `json:"title,omitempty"`
	// Model is Claude's --model for the session: an alias, a full model name,
	// or a gateway slug. Empty keeps Claude's default.
	Model string `json:"model,omitempty"`
	// Agent is the coding agent the session runs: "claude" or "codex"; empty
	// is Claude. Recorded by the first create; a repeated one never changes it.
	Agent string `json:"agent,omitempty"`
	// GitUser is the git identity for commits; nil uses the system default.
	GitUser *GitUser `json:"gitUser,omitempty"`
}

// SetModelRequest switches a workspace's session to another model. With a
// gateway ("openrouter") the session runs through it on Token instead of the
// user's Claude credential, and Model is the gateway's name for the model.
type SetModelRequest struct {
	Model   string `json:"model"`
	Gateway string `json:"gateway,omitempty"`
	Token   string `json:"token,omitempty"`
	// Effort is the reasoning effort to run at ("low" … "max"); empty runs at
	// the model's own.
	Effort string `json:"effort,omitempty"`
}

// SetAuthRequest gives a workspace's session its own credential, applied at
// its next launch: Kind is "claude-oauth-token" or "anthropic-api-key" for a
// Claude session, "openai-api-key" for a Codex one, or "none" to take it
// away (the agent's own login applies again), which carries no Token.
type SetAuthRequest struct {
	Kind  string `json:"kind"`
	Token string `json:"token,omitempty"`
}

// ListingWorkspaceID is the workspace claim of the only token that may list an
// agent's sessions (GET /workspaces). No real workspace can have it — the id
// checks on both sides refuse '*' — so a token issued for one workspace, like
// those in /pty URLs, can never enumerate the others.
const ListingWorkspaceID = "*"

// Activity is what GET /activity reports for the whole box: the most recent
// activity in any session or from a user (terminal input, a control call), and
// whether Claude is mid-turn anywhere. The control plane pauses an idle box.
type Activity struct {
	LastActivity   string `json:"lastActivity"` // RFC3339 UTC
	TurnInProgress bool   `json:"turnInProgress"`
}

// LocalSession is one local session the agent on a user's Mac knows about, as
// the desktop app lists them. Local sessions are not in the shared database:
// they exist only on the Mac that runs them.
type LocalSession struct {
	WorkspaceID string `json:"workspaceId"`
	// Name is the folder's name; Folder its path; Worktree where Claude works
	// (the folder itself when InPlace).
	Name       string `json:"name"`
	Title      string `json:"title"`
	Folder     string `json:"folder"`
	Worktree   string `json:"worktree"`
	Branch     string `json:"branch"`
	BaseBranch string `json:"baseBranch"`
	InPlace    bool   `json:"inPlace"`
	CreatedAt  string `json:"createdAt"`
	// LastActiveAt is when Claude last wrote to the session's transcript, so a
	// session made weeks ago but used today reads as today; CreatedAt when there
	// is no transcript yet. Omitted by agents older than the field.
	LastActiveAt string `json:"lastActiveAt,omitempty"`
	// Running is whether Claude's session is live right now.
	Running bool `json:"running"`
	// Model is the session's model; empty when it runs Claude's default.
	Model string `json:"model,omitempty"`
	// Gateway is what it runs through ("openrouter"); empty for the user's
	// own Claude. The key is never listed.
	Gateway string `json:"gateway,omitempty"`
	// Agent is the coding agent it runs ("claude", "codex"); empty is Claude.
	Agent string `json:"agent,omitempty"`
}

// WorkspaceActionRequest addresses one workspace (start/stop/archive/...).
type WorkspaceActionRequest struct {
	WorkspaceID string `json:"workspaceId"`
}

// ArchiveUpload is one signed upload URL the control plane mints for an artifact.
// The agent PUTs that artifact's bytes to the URL; it never holds bucket
// credentials (M4 open decision #1). `artifact` is a key of the shared
// SNAPSHOT_ARTIFACTS table (conversation/cast/bundle/patch/summary/manifest).
type ArchiveUpload struct {
	Artifact string `json:"artifact"`
	URL      string `json:"url"`
}

// ArchiveWorkspaceRequest carries the archive-time inputs the agent needs to
// PRODUCE a Snapshot: the logical archive timestamp (recorded verbatim in the
// manifest so it matches the storage prefix Next derived from it) and one signed
// upload URL per artifact. The response is the manifest.json the agent assembled
// and uploaded LAST — its presence in storage marks the Snapshot complete.
type ArchiveWorkspaceRequest struct {
	ArchivedAt string          `json:"archivedAt"`
	Uploads    []ArchiveUpload `json:"uploads"`
}

// RestoreDownload is one signed download URL for a Snapshot artifact the agent
// needs to rebuild a Session: `artifact` is one of bundle/patch/conversation,
// or a Codex session's optional rollout. Encoding "gzip" is an artifact stored
// compressed (an imported session's), decompressed as it downloads.
type RestoreDownload struct {
	Artifact string `json:"artifact"`
	URL      string `json:"url"`
	Encoding string `json:"encoding,omitempty"`
}

// RestoreWorkspaceRequest carries what the agent needs to rebuild an archived
// Session on a (possibly fresh) box: the branch to check out, the Claude
// sessionId to place the conversation under so `claude --continue` resumes the
// exact session, and signed download URLs for the tree (bundle + patch) and the
// conversation JSONL. The agent materializes, VERIFIES, and only then relaunches
// Claude — a failed verification aborts without booting Claude.
type RestoreWorkspaceRequest struct {
	Branch     string            `json:"branch"`
	BaseBranch string            `json:"baseBranch,omitempty"`
	SessionID  *string           `json:"sessionId"`
	Downloads  []RestoreDownload `json:"downloads"`
	// Agent is the session's agent ("claude", "codex"; empty is Claude): a
	// fresh box has no record of it. A Codex session's optional "rollout"
	// download resumes Codex itself; without it the session starts afresh,
	// its translated conversation restored.
	Agent string `json:"agent,omitempty"`
	// Auth is the session's own credential, recorded before it relaunches
	// (validated like POST /workspaces/{id}/auth).
	Auth *SetAuthRequest `json:"auth,omitempty"`
	// BundleRef is the branch as the bundle names it, when the session is
	// restored onto another name (an import whose branch was taken).
	BundleRef string `json:"bundleRef,omitempty"`
	// OriginWorktree is the folder an imported session worked in on its Mac:
	// the conversation's working directories under it move to the worktree.
	OriginWorktree string `json:"originWorktree,omitempty"`
	// Model is the model the session was on, with its gateway and key when it
	// runs through one, recorded before it relaunches (validated like POST
	// /workspaces/{id}/model): a fresh box has no record of it. Absent, the
	// session relaunches on its agent's own default.
	Model *SetModelRequest `json:"model,omitempty"`
}

// Health is what the unauthenticated GET /health says: that the agent is up,
// the gateways it can run a session through, the agents it can run, and the
// features it has. Each list is absent from agents older than it.
type Health struct {
	Status   string   `json:"status"`
	Gateways []string `json:"gateways,omitempty"`
	Agents   []string `json:"agents,omitempty"`
	// Features are what this agent can do that an older one can't, for the
	// control plane to upgrade a box before asking for one (FeatureImports).
	Features []string `json:"features,omitempty"`
}

// SetEnvironmentRequest gives a session its project's environment: the
// variables its launch exports and the setup script its next launch runs
// once in its worktree. Empty removes them. (POST /workspaces/{id}/environment)
type SetEnvironmentRequest struct {
	Env map[string]string `json:"env"`
	// Files are files a checkout keeps out of git (its .env files), by path
	// in it: the setup script finds them under $CONDUCTOR_ROOT_PATH, and a
	// session with no setup script gets them in its worktree.
	Files map[string]string `json:"files,omitempty"`
	Setup string            `json:"setup,omitempty"`
	// Instructions are the project's for its agent, given after Outrunner's
	// own orientation at every launch (FeatureInstructions). Empty removes
	// them.
	Instructions string `json:"instructions,omitempty"`
	// WarmHook runs once in the session's worktree at its first launch,
	// unless the worktree was warmed on a ready box; StartHook at every
	// launch (FeatureWarmHooks). Empty removes them.
	WarmHook  string `json:"warmHook,omitempty"`
	StartHook string `json:"startHook,omitempty"`
}

// FeatureWarmHooks is POST/GET /warm, a ready box's warming, and
// SetEnvironmentRequest's WarmHook and StartHook.
const FeatureWarmHooks = "warm-hooks"

// WarmRequest warms a ready box (POST /warm, the listing token): a checkout
// of BaseBranch with the project's files in it and its hook run there.
type WarmRequest struct {
	BaseBranch string            `json:"baseBranch"`
	Env        map[string]string `json:"env,omitempty"`
	Files      map[string]string `json:"files,omitempty"`
	Hook       string            `json:"hook,omitempty"`
}

// WarmStatus is how a box's warming went (GET /warm): State is "", running,
// succeeded or failed; Log the end of the hook's output.
type WarmStatus struct {
	State      string `json:"state"`
	BaseBranch string `json:"baseBranch,omitempty"`
	StartedAt  string `json:"startedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
	ExitCode   int    `json:"exitCode,omitempty"`
	Log        string `json:"log,omitempty"`
}

// SetAgentConfigRequest is the user's own agent setup for this computer
// (POST /config): an archive of their CLAUDE.md, skills, subagents, commands
// and AGENTS.md, downloaded unless its version is installed (none: any
// installed is removed), and Claude's MCP servers and plugin settings.
type SetAgentConfigRequest struct {
	Version    string                     `json:"version,omitempty"`
	URL        string                     `json:"url,omitempty"`
	SHA256     string                     `json:"sha256,omitempty"`
	MCPServers map[string]json.RawMessage `json:"mcpServers,omitempty"`
	Settings   map[string]json.RawMessage `json:"settings,omitempty"`
}

// FeatureAgentConfig is POST /config.
const FeatureAgentConfig = "agent-config"

// FeatureEnvironment is POST /workspaces/{id}/environment.
const FeatureEnvironment = "session-environment"

// FeatureInstructions is SetEnvironmentRequest's Instructions: an older
// agent ignores them.
const FeatureInstructions = "project-instructions"

// FeatureRequestSecrets is a Claude session's request_secrets tool and
// POST /workspaces/{id}/secrets, the user's answer to it.
const FeatureRequestSecrets = "request-secrets"

// ProvideSecretsRequest is the user's answer to the request for secrets a
// session is waiting on (POST /workspaces/{id}/secrets): the request's
// variables, as the form showed them, and the values given for some of
// them; or that the user skipped it.
type ProvideSecretsRequest struct {
	Keys    []string          `json:"keys"`
	Values  map[string]string `json:"values,omitempty"`
	Skipped bool              `json:"skipped,omitempty"`
}

// FeatureImports is restoring an imported session: compressed downloads, a
// bundle's branch under another name, and the conversation's folder moved.
const FeatureImports = "restore-imports"

// FeatureEditor is POST /workspaces/{id}/editor: VS Code in the browser.
const FeatureEditor = "editor"

// EditorResponse is where the session's editor is: the box port code-server
// answers on, reached through the provider's preview URL, and the folder to
// open it on.
type EditorResponse struct {
	Port   int    `json:"port"`
	Folder string `json:"folder"`
}

// FeaturePorts is GET /workspaces/{id}/ports: the servers running on the box.
const FeaturePorts = "ports"

// PortsResponse is the servers listening on the session's box, for its owner
// to open through the provider's preview URL.
type PortsResponse struct {
	Ports []ListeningPort `json:"ports"`
}

// ListeningPort is one of them, with its program where the agent can see it.
type ListeningPort struct {
	Port    int    `json:"port"`
	Process string `json:"process,omitempty"`
}

// FeatureRestoreModel is a restore that puts the session back on its model
// (RestoreWorkspaceRequest.Model). An older agent ignores the field, and
// relaunches the session on Claude's own default.
const FeatureRestoreModel = "restore-model"

// FeatureCodexGateway is a Codex session on a gateway (SetModelRequest's
// gateway, for OpenRouter): Outrunner's models in Codex. An older agent
// refuses the gateway.
const FeatureCodexGateway = "codex-gateway"

// ErrorResponse is the stable error envelope for control-plane failures.
type ErrorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// SessionUrls is the browser's handle to one Workspace Session, returned by
// POST /api/workspaces/[id]/session. Each URL already carries the 5-min token.
type SessionUrls struct {
	PtyUrl    string            `json:"ptyUrl"`
	EventsUrl string            `json:"eventsUrl,omitempty"`
	Summary   *WorkspaceSummary `json:"summary,omitempty"`
}

// WorkspaceSummary is the canonical, cross-milestone summary of a Workspace
// Session — the shape Mission Engine and the M4 Snapshot manifest consume.
// M3 owns this type; other packages import it. See docs/architecture/m4-plan.md
// and docs/architecture/session-contract.md.
type WorkspaceSummary struct {
	State                string            `json:"state"`
	StartedAt            string            `json:"startedAt"`
	EndedAt              *string           `json:"endedAt"`
	Duration             int64             `json:"duration"` // seconds
	LastActivity         string            `json:"lastActivity"`
	TokenUsage           TokenUsageAmounts `json:"tokenUsage"`
	ChangedFiles         int               `json:"changedFiles"`
	FilesTouched         []string          `json:"filesTouched"`
	CommitCount          int               `json:"commitCount"`
	LastAssistantMessage *string           `json:"lastAssistantMessage"`
}

// TokenUsageAmounts is the numbers-only projection embedded in WorkspaceSummary.
// It intentionally omits `service_tier` from the standalone `TokenUsage` event —
// the Summary is interoperable with M4's placeholder validator and Mission's
// shape (record of numbers); per-turn service_tier lives on the event.
type TokenUsageAmounts struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// ContentBlock is one block inside a ConversationMessage.
// type ∈ {text, thinking, tool_use, tool_result}.
type ContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"toolUseId,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
}

// ConversationMessage is a structured turn derived from Claude's JSONL.
type ConversationMessage struct {
	T          string  `json:"t"` // "message"
	UUID       string  `json:"uuid"`
	ParentUUID *string `json:"parentUuid"`
	Role       string  `json:"role"`
	Model      string  `json:"model,omitempty"` // assistant turns only
	// Why the assistant reply stopped, as Claude logs it ("tool_use": the turn
	// goes on; "end_turn" and the like: it's over). Empty where the log says
	// none (a user turn, a Codex translation).
	StopReason string         `json:"stopReason,omitempty"`
	Timestamp  string         `json:"timestamp"`
	Content    []ContentBlock `json:"content"`
}

// TokenUsage is an assistant usage delta.
type TokenUsage struct {
	T                        string `json:"t"` // "usage"
	InputTokens              int    `json:"input_tokens"`
	OutputTokens             int    `json:"output_tokens"`
	CacheCreationInputTokens int    `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int    `json:"cache_read_input_tokens"`
	ServiceTier              string `json:"service_tier,omitempty"`
}

// WorkspaceStateChanged reports a workspace lifecycle transition.
// state ∈ {starting, running, exited, archived, degraded}.
type WorkspaceStateChanged struct {
	T           string `json:"t"` // "state"
	WorkspaceID string `json:"workspaceId"`
	State       string `json:"state"`
}

// ChangedFile is one entry of a workspace's change set, mirroring ChangedFile in
// lib/runtime/types.ts (the shape /api/workspaces/[id]/changes returns).
type ChangedFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

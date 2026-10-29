/**
 * FROZEN wire contract between the Next control plane, the browser, and the Go
 * runtime-agent. This is the single source of truth: everything crossing the
 * boundary is validated against these zod schemas — no ad-hoc JSON.
 *
 * The agent (Go) mirrors these shapes as structs. Golden fixtures in
 * `agent-protocol.fixtures.json` are validated by BOTH sides in CI so the two
 * languages can never silently drift.
 *
 * See docs/architecture/protocol.md for the prose description.
 */

import { z } from "zod";

import {
  OPTIONAL_SNAPSHOT_ARTIFACTS,
  SNAPSHOT_ARTIFACTS,
  type OptionalSnapshotArtifact,
  type SnapshotArtifact,
} from "@/lib/runtime/snapshot/manifest";

// ---------------------------------------------------------------------------
// Auth — the short-lived Runtime token the agent verifies on every connection.
// ---------------------------------------------------------------------------

export const RuntimeTokenClaims = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  computerId: z.string().min(1),
  userId: z.string().min(1),
  /** Unix seconds. Minted with a 5-minute TTL; verified at connect time. */
  exp: z.number().int().positive(),
});
export type RuntimeTokenClaims = z.infer<typeof RuntimeTokenClaims>;

// ---------------------------------------------------------------------------
// PTY socket (WS /pty) — bidirectional terminal frames.
// ---------------------------------------------------------------------------

export const PtyClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("input"), data: z.string() }),
  z.object({
    t: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type PtyClientMessage = z.infer<typeof PtyClientMessage>;

export const PtyServerMessage = z.discriminatedUnion("t", [
  // Coalesced terminal output (already redacted). seq is monotonic per socket.
  z.object({ t: z.literal("output"), data: z.string(), seq: z.number().int().nonnegative() }),
  // Whether this connection holds the keyboard (one writer, others read-only).
  z.object({ t: z.literal("role"), writer: z.boolean() }),
  // The Claude/PTY process exited; the UI offers resume.
  z.object({ t: z.literal("exit"), code: z.number().int() }),
  z.object({ t: z.literal("pong") }),
]);
export type PtyServerMessage = z.infer<typeof PtyServerMessage>;

// ---------------------------------------------------------------------------
// Control API (HTTP, Next -> agent). Requests + a stable error envelope.
// ---------------------------------------------------------------------------

/** The coding agent a session runs. Omitted wherever it is optional: Claude. */
export const AgentName = z.enum(["claude", "codex"]);
export type AgentName = z.infer<typeof AgentName>;

/** POST /workspaces/{id}/environment: a session's project variables, sourced
 *  by its launch; its checkout's .env files, under $CONDUCTOR_ROOT_PATH (and
 *  in the worktree when there's no setup script); and the setup script its
 *  next launch runs once. */
export const SetEnvironmentRequest = z
  .object({
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string()),
    /** Files the checkout kept out of git (its .env files), by path in it. */
    files: z
      .record(
        z.string().refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), {
          message: "a path in the checkout",
        }),
        z.string(),
      )
      .optional(),
    setup: z.string().max(64 * 1024).optional(),
    /** The project's instructions for its agent, after Outrunner's own at
     *  every launch (AGENT_FEATURE_INSTRUCTIONS). */
    instructions: z.string().max(16 * 1024).optional(),
    /** The project's warm hook, run once at the session's first launch
     *  unless its worktree was warmed on a ready box, and its start hook, run
     *  at every launch (AGENT_FEATURE_WARM_HOOKS). */
    warmHook: z.string().max(64 * 1024).optional(),
    startHook: z.string().max(64 * 1024).optional(),
  })
  .strict();
export type SetEnvironmentRequest = z.infer<typeof SetEnvironmentRequest>;

/** POST /config: the user's own agent setup for the computer — an archive of
 *  their CLAUDE.md, skills, subagents, commands and AGENTS.md (downloaded
 *  unless its version is installed; none removes any), Claude's MCP servers
 *  and plugin settings. */
export const SetAgentConfigRequest = z
  .object({
    version: z.string().optional(),
    url: z.string().url().optional(),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => !v.url || (v.version && v.sha256), { message: "an archive needs its version and digest", path: ["url"] });
export type SetAgentConfigRequest = z.infer<typeof SetAgentConfigRequest>;

/** The agent takes the user's own setup (POST /config). */
export const AGENT_FEATURE_AGENT_CONFIG = "agent-config";

/** POST /skills: a project's skills for the computer, from the GitHub
 *  repositories they install from, each downloaded as it is now into
 *  ~/.claude/skills (Claude) and ~/.agents/skills (Codex). `skills` names
 *  the ones to install (a SKILL.md's name, or its folder's), none every one
 *  the repository holds; `ref` is a branch, none its default; `token` reads
 *  a private one. None removes the skills installed before. */
export const SkillSource = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
    ref: z.string().regex(/^[A-Za-z0-9._/-]{1,255}$/).optional(),
    token: z.string().min(1).optional(),
    skills: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).optional(),
  })
  .strict();
export type SkillSource = z.infer<typeof SkillSource>;

export const SetSkillsRequest = z.object({ sources: z.array(SkillSource).max(50) }).strict();
export type SetSkillsRequest = z.infer<typeof SetSkillsRequest>;

/** What POST /skills installed, by name, and what it couldn't: a
 *  repository it couldn't download, or one skill of it. */
export const SetSkillsResponse = z.object({
  installed: z.array(z.string()),
  failed: z.array(z.object({ repo: z.string(), skill: z.string().optional(), error: z.string() })).optional(),
});
export type SetSkillsResponse = z.infer<typeof SetSkillsResponse>;

/** The agent installs a project's skills (POST /skills). */
export const AGENT_FEATURE_SKILLS = "environment-skills";

/** A Codex session loads the computer's MCP servers (SetAgentConfigRequest's
 *  `mcpServers`), as a Claude one always has; an older agent gives them to
 *  Claude alone. */
export const AGENT_FEATURE_CODEX_MCP = "codex-mcp";

/** POST /agent-context: what every session on the computer reads besides
 *  its orientation, as Markdown placed in a block in agent instruction files. */
export const SetAgentContextRequest = z.object({ content: z.string().max(64 * 1024) }).strict();
export type SetAgentContextRequest = z.infer<typeof SetAgentContextRequest>;

/** The agent takes POST /agent-context. */
export const AGENT_FEATURE_AGENT_CONTEXT = "agent-context";

/** The agent takes a session's environment (POST /workspaces/{id}/environment). */
export const AGENT_FEATURE_ENVIRONMENT = "session-environment";

/** The agent gives a session its project's instructions
 *  (SetEnvironmentRequest's `instructions`); an older one ignores them. */
export const AGENT_FEATURE_INSTRUCTIONS = "project-instructions";

/** The agent makes sessions of several repositories (CreateWorkspaceRequest's
 *  `repos`). */
export const AGENT_FEATURE_MULTI_REPO = "multi-repo";

/** The agent archives a session of several repositories and restores one
 *  (RestoreWorkspaceRequest's `repos`). */
export const AGENT_FEATURE_MULTI_REPO_SNAPSHOTS = "multi-repo-snapshots";

/** The agent warms a ready box (POST/GET /warm) and runs a session's warm
 *  and start hooks. */
export const AGENT_FEATURE_WARM_HOOKS = "warm-hooks";

/** The agent warms a ready box of a project of several repositories in a
 *  folder of their checkouts (WarmRequest's `repos`), and a session of the
 *  same repositories takes it. An older one is left unwarmed: it would warm
 *  one checkout no session of the project takes. */
export const AGENT_FEATURE_MULTI_REPO_WARM = "multi-repo-warm";

/** The agent sends a message once per key (POST /message's `key`), kept on
 *  the box's disk: a Mission's events, sent again after a restart on our
 *  side, reach Claude once (lib/missions/outbox.ts). */
export const AGENT_FEATURE_MESSAGE_KEYS = "message-keys";

/** The agent's git and `gh` ask Outrunner for GitHub tokens as they need them
 *  (app/api/runtime/git-credential), rather than keep the one it booted with:
 *  the Outrunner App's last an hour. */
export const AGENT_FEATURE_GIT_CREDENTIAL = "git-credential";

/** A project's several repositories, each in its own folder (its
 *  checkout) off its mirror at $ROOT/repos/<checkout>.git. */
const RepoCheckouts = z
  .array(
    z.object({
      fullName: z.string().min(1),
      checkout: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/),
      baseBranch: z.string().min(1),
    }),
  )
  .min(2)
  .max(5);

/** POST /warm (the listing token): warm a ready box, a checkout of the base
 *  branch with the project's files in it and its warm hook run there. */
export const WarmRequest = z
  .object({
    baseBranch: z.string().min(1),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string()).optional(),
    files: z.record(z.string(), z.string()).optional(),
    hook: z.string().max(64 * 1024).optional(),
    /** A project's several repositories (AGENT_FEATURE_MULTI_REPO_WARM): a
     *  folder of their checkouts, laid out as its sessions' are, with the
     *  hook run at its root. `baseBranch` is then the first's. */
    repos: RepoCheckouts.optional(),
  })
  .strict();
export type WarmRequest = z.infer<typeof WarmRequest>;

/** GET /warm: how the box's warming went, with the end of its log. */
export const WarmStatus = z
  .object({
    state: z.enum(["", "running", "succeeded", "failed"]),
    baseBranch: z.string().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    exitCode: z.number().int().optional(),
    log: z.string().optional(),
  })
  .strict();
export type WarmStatus = z.infer<typeof WarmStatus>;

/** What an agent can do that an older one can't: `restore-imports` restores
 *  an imported session (compressed downloads, its branch renamed, its
 *  conversation moved to the worktree). */
export const AGENT_FEATURE_IMPORTS = "restore-imports";

/** The agent runs VS Code in the browser (POST /workspaces/{id}/editor). */
export const AGENT_FEATURE_EDITOR = "editor";

/** Where a session's editor is: the box port code-server answers on, reached
 *  through the provider's preview URL, and the folder to open it on. */
export const EditorResponse = z
  .object({ port: z.number().int().min(1).max(65535), folder: z.string().startsWith("/") })
  .strict();
export type EditorResponse = z.infer<typeof EditorResponse>;

/** The agent lists the servers running on its box (GET /workspaces/{id}/ports). */
export const AGENT_FEATURE_PORTS = "ports";

/** The servers listening on a session's box, lowest port first, each with its
 *  program where the agent can see it. */
export const PortsResponse = z
  .object({
    ports: z.array(
      z.object({ port: z.number().int().min(1).max(65535), process: z.string().optional() }).strict(),
    ),
  })
  .strict();
export type PortsResponse = z.infer<typeof PortsResponse>;

/** A session's changed files since its base branch, as git on its box reads
 *  them (GET /workspaces/{id}/changes): the shape /api/workspaces/[id]/changes
 *  answers in. Not strict: a field added later doesn't fail an older page. */
export const ChangesResponse = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

/** The agent lists a session's files (GET /workspaces/{id}/files). */
export const AGENT_FEATURE_FILES = "files";

/** A session's files, for the composer's @ mentions: the first `changed` are
 *  those changed since its base branch, most recently written first; then the
 *  repository's others (tracked, and untracked but not ignored). `truncated`
 *  where there were more than the agent lists. */
export const FilesResponse = z.object({
  files: z.array(z.string()),
  changed: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
});
export type FilesResponse = z.infer<typeof FilesResponse>;

/** The agent shows a session's Canvas (GET /workspaces/{id}/canvas and
 *  /canvas/file?path=): the folder its agent writes plans, reports, pages,
 *  diagrams and images in for the user. */
export const AGENT_FEATURE_CANVAS = "canvas";

/** A session's Canvas: `dir` the folder on the box, `files` by path in it,
 *  newest first. `truncated` where there were more than the agent lists. */
export const CanvasResponse = z.object({
  dir: z.string(),
  files: z.array(z.object({ path: z.string().min(1), size: z.number().int().nonnegative(), modifiedAt: z.string() })),
  truncated: z.boolean().optional(),
});
export type CanvasResponse = z.infer<typeof CanvasResponse>;

/** One changed file's bounded diff (GET /workspaces/{id}/changes?path=). */
export const ChangedFileDiffResponse = z.object({ diff: z.string() });

/** The agent takes SendMessageRequest's `mode` and `dismiss`: plan mode. An
 *  older one ignores them, and would run a plan as a build. */
export const AGENT_FEATURE_PLAN_MODE = "plan-mode";

/** A session's modes: plan (Claude's --permission-mode plan, Codex
 *  read-only) and build, its own (bypassPermissions on a Runtime Computer). */
export const SessionMode = z.enum(["build", "plan"]);
export type SessionMode = z.infer<typeof SessionMode>;

/** POST /workspaces/{id}/message: a prompt for the session. `mode` relaunches
 *  a session not already in it first, its conversation continued; `dismiss`
 *  closes the menu the agent shows (a plan waiting on approval) as Escape
 *  does, so the prompt answers it. */
export const SendMessageRequest = z
  .object({
    content: z.string().min(1),
    mode: SessionMode.optional(),
    dismiss: z.boolean().optional(),
    // Sent once per key (AGENT_FEATURE_MESSAGE_KEYS); an older agent ignores it.
    key: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** POST /workspaces/{id}/plan: answer the plan the session's agent waits on.
 *  "approve" goes on to build it, through Claude's own plan menu where it
 *  offers the session's build mode, else as a prompt in build mode; the
 *  answer says which (`via`). Revising is a prompt in plan mode. */
export const PlanActionRequest = z.object({ action: z.literal("approve") }).strict();
export type PlanActionRequest = z.infer<typeof PlanActionRequest>;
export const PlanActionResponse = z.object({
  result: z.enum(["approved", "answered"]),
  // How it was approved.
  via: z.enum(["menu", "prompt"]).optional(),
  // "answered": no plan was waiting (answered in another tab, the terminal),
  // and this is the mode the session is in, as its screen says.
  mode: SessionMode.optional(),
});
export type PlanActionResponse = z.infer<typeof PlanActionResponse>;

/** The agent runs several chats in a session: POST /workspaces/{id}/chats
 *  makes one, and `?chat=` names one on the session's routes and streams. An
 *  agent without it has the main chat alone, which they reach unnamed. */
export const AGENT_FEATURE_CHATS = "chats";

/** The chat every session has: the session itself, which an agent from before
 *  chats runs, and where a send that names no chat goes. */
export const MAIN_CHAT = "main";

/** A chat's id as the agent takes it: the control plane's UUIDs. */
export const ChatId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).refine((id) => id !== MAIN_CHAT);

/** POST /workspaces/{id}/chats: a new chat in the session, started unless
 *  `noStart`. `agent` is its own (absent: the session's); `from` forks it
 *  from one of the session's chats ("main" for the main one), its handoff
 *  naming that chat `fromName`; `side` makes it a side chat about `from`. */
export const CreateChatRequest = z
  .object({
    chatId: ChatId,
    agent: z.enum(["claude", "codex"]).optional(),
    from: z.union([z.literal(MAIN_CHAT), ChatId]).optional(),
    fromName: z.string().max(200).optional(),
    side: z.boolean().optional(),
    noStart: z.boolean().optional(),
  })
  .strict()
  .refine((req) => !req.side || req.from !== undefined, { message: "A side chat is about another chat." });
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

/** The agent compacts a session's conversation (POST /workspaces/{id}/compact). */
export const AGENT_FEATURE_COMPACT = "compact";

/** POST /workspaces/{id}/compact: as /compact does in the session's terminal,
 *  with what to keep in the summary, if anything. The session and its
 *  conversation go on; the stream shows the compaction (ConversationMessage's
 *  `compact`) once the agent has written it. */
export const CompactRequest = z.object({ instructions: z.string().max(2000).optional() }).strict();
export type CompactRequest = z.infer<typeof CompactRequest>;

/** The agent restores a session onto its model (RestoreWorkspaceRequest's
 *  `model`); an older one ignores it, and relaunches on Claude's default. */
export const AGENT_FEATURE_RESTORE_MODEL = "restore-model";

/** The agent runs a Codex session through a gateway (OpenRouter): Outrunner's
 *  models in Codex. An older one refuses the gateway. */
export const AGENT_FEATURE_CODEX_GATEWAY = "codex-gateway";

/** GET /health (unauthenticated): the agent is up, and what it can run a
 *  session on. `gateways`, `agents` and `features` are absent from agents
 *  older than each: those run OpenRouter alone, and Claude alone. */
export const AgentHealth = z.object({
  status: z.literal("ok"),
  gateways: z.array(z.string()).optional(),
  agents: z.array(AgentName).optional(),
  features: z.array(z.string()).optional(),
});
export type AgentHealth = z.infer<typeof AgentHealth>;

/** A credential as the agent takes it: printable ASCII with no space, quote
 *  or backslash (it is written into a sourced shell file), 20 to 400 long. */
const CredentialToken = z.string().regex(/^[\x21-\x26\x28-\x5b\x5d-\x7e]{20,400}$/);

/**
 * POST /workspaces/{id}/auth: the session's own credential, applied at its
 * next launch. claude-oauth-token and anthropic-api-key are a Claude
 * session's, openai-api-key a Codex session's (another agent's is refused);
 * none takes the credential away and carries no token. An unknown session is
 * 404 with the NOT_FOUND envelope (an agent without the route: a bare 404);
 * a credential on an engine that runs sessions on its own login (jcode),
 * 409 UNSUPPORTED.
 */
/**
 * POST /workspaces/{id}/answer: the user's reply to the questions the session
 * is waiting on (runtime-agent/internal/ask). `questions` are the ask_user
 * call's, as the transcript has them; the agent checks the reply against them.
 * A dismissed card carries no answers.
 */
export const AnswerRequest = z.object({
  questions: z.array(z.unknown()).min(1).max(4),
  answers: z
    .array(z.object({ selected: z.array(z.string().max(500)).max(4), other: z.string().max(4000) }))
    .max(4)
    .optional(),
  dismissed: z.boolean().optional(),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** The agent serves request_secrets and takes its answer
 *  (POST /workspaces/{id}/secrets). */
export const AGENT_FEATURE_REQUEST_SECRETS = "request-secrets";

/**
 * POST /workspaces/{id}/secrets: the user's answer to the request for
 * secrets the session is waiting on (runtime-agent/internal/ask/secrets.go).
 * `keys` are the request's variables as the form showed them; the agent
 * matches them to the call. Values for some of them, or skipped.
 */
export const ProvideSecretsRequest = z
  .object({
    keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).min(1).max(10),
    values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().min(1).max(64 * 1024)).optional(),
    skipped: z.boolean().optional(),
  })
  .strict();
export type ProvideSecretsRequest = z.infer<typeof ProvideSecretsRequest>;

export const SetAuthRequest = z
  .object({
    kind: z.enum(["none", "claude-oauth-token", "anthropic-api-key", "openai-api-key"]),
    token: CredentialToken.optional(),
  })
  .refine((v) => (v.kind === "none") === (v.token === undefined), {
    message: "a credential needs its token, and none takes one",
    path: ["token"],
  });
export type SetAuthRequest = z.infer<typeof SetAuthRequest>;

/** Git user identity for commits. When provided, the agent configures git
 *  user.name and user.email in the worktree so commits are attributed to the
 *  Outrunner user rather than a generic identity. */
export const GitUser = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});
export type GitUser = z.infer<typeof GitUser>;

export const CreateWorkspaceRequest = z.object({
  workspaceId: z.string().min(1),
  repoFullName: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  /** Existing checkout on the user's Mac to branch from (local sessions only);
   *  omitted, the worktree comes from the computer's bare mirror. */
  repoPath: z.string().min(1).optional(),
  /** Claude's --permission-mode; omitted takes the agent's default (bypass on a
   *  Runtime Computer). A repoPath session refuses bypassPermissions. */
  permissionMode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  /** Labels a local session in the desktop's list (the first prompt). */
  title: z.string().optional(),
  /** The session's agent; omitted is Claude. Recorded by the first create, a
   *  repeated one never changes it. An agent from before agents ignores it
   *  and runs Claude: check `agents` on /health first. */
  agent: AgentName.optional(),
  /** Git user identity for commits; omitted uses the system default. */
  gitUser: GitUser.optional(),
  /** A project's several repositories (AGENT_FEATURE_MULTI_REPO): the
   *  session works in a folder of worktrees, one a repository, each off its
   *  mirror at $ROOT/repos/<checkout>.git, all on `branch`. */
  repos: RepoCheckouts.optional(),
  /** Outrunner's standing instructions for the session beyond its
   *  orientation, given at every launch after it: how it writes a pull
   *  request (lib/session/pr-template.ts prGuide). An older agent ignores it. */
  guide: z.string().max(32 * 1024).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

/** start/stop/archive/restore/delete all address one workspace by id. */
export const WorkspaceActionRequest = z.object({
  workspaceId: z.string().min(1),
});
export type WorkspaceActionRequest = z.infer<typeof WorkspaceActionRequest>;

/** The six Snapshot artifact keys (archive covers all; restore reads a subset). */
const ARCHIVE_ARTIFACTS = Object.keys(SNAPSHOT_ARTIFACTS) as [
  SnapshotArtifact,
  ...SnapshotArtifact[],
];
const RESTORE_ARTIFACTS = ["bundle", "patch", "conversation"] as const;
/** Artifacts a request may add to those: a Codex session's raw rollout. */
const OPTIONAL_ARTIFACTS = Object.keys(OPTIONAL_SNAPSHOT_ARTIFACTS) as [
  OptionalSnapshotArtifact,
  ...OptionalSnapshotArtifact[],
];

/** True when `got` is exactly `want` as a set, plus any of `optional` — no
 *  missing, extra, or dup keys. */
function coversExactly(got: string[], want: readonly string[], optional: readonly string[] = []): boolean {
  const set = new Set(got);
  const required = got.filter((k) => !optional.includes(k));
  return (
    set.size === got.length &&
    required.length === want.length &&
    want.every((k) => set.has(k))
  );
}

/**
 * One signed upload URL the control plane mints for a Snapshot artifact. The
 * agent PUTs that artifact's bytes to the URL — it never holds bucket
 * credentials (M4 open decision #1). `artifact` is a key of SNAPSHOT_ARTIFACTS.
 */
export const ArchiveUpload = z.object({
  artifact: z.enum([...ARCHIVE_ARTIFACTS, ...OPTIONAL_ARTIFACTS]),
  url: z.string().url(),
});
export type ArchiveUpload = z.infer<typeof ArchiveUpload>;

/**
 * Archive-time inputs the agent needs to PRODUCE a Snapshot: the logical archive
 * timestamp (echoed verbatim into the manifest so it matches the storage prefix
 * Next derived from it) and a signed upload URL for EVERY artifact — requiring
 * the full set here prevents an incomplete Snapshot (a manifest pointing at
 * missing objects) from ever being persisted as an archived workspace.
 */
export const ArchiveWorkspaceRequest = z
  .object({
    archivedAt: z.string().min(1),
    uploads: z.array(ArchiveUpload),
  })
  .refine((v) => coversExactly(v.uploads.map((u) => u.artifact), ARCHIVE_ARTIFACTS, OPTIONAL_ARTIFACTS), {
    message: "archive uploads must cover exactly the six Snapshot artifacts (and may add a rollout)",
    path: ["uploads"],
  });
export type ArchiveWorkspaceRequest = z.infer<typeof ArchiveWorkspaceRequest>;

/** One signed download URL for a Snapshot artifact the agent reads at Restore. */
export const RestoreDownload = z.object({
  artifact: z.enum([...RESTORE_ARTIFACTS, ...OPTIONAL_ARTIFACTS]),
  url: z.string().url(),
  /** How the artifact is stored: "gzip" for an imported session's. */
  encoding: z.literal("gzip").optional(),
});
export type RestoreDownload = z.infer<typeof RestoreDownload>;

/**
 * Inputs to rebuild an archived Session on a (possibly fresh) box: the branch to
 * check out, the Claude sessionId to place the conversation under (so
 * `claude --continue` resumes the exact session), and download URLs for EVERY
 * artifact Restore needs — `bundle`, `patch`, and `conversation`. Requiring the
 * full set prevents a false-success restore that can't resume the session.
 */
export const RestoreWorkspaceRequest = z
  .object({
    branch: z.string().min(1),
    baseBranch: z.string().optional(),
    sessionId: z.string().min(1).nullable(),
    downloads: z.array(RestoreDownload),
    /** The session's agent (a fresh box has no record of it); omitted is
     *  Claude. A Codex session resumes by its `rollout` download when the
     *  Snapshot has one, else starts afresh with its conversation restored. */
    agent: AgentName.optional(),
    /** The session's own credential, recorded before it relaunches. */
    auth: SetAuthRequest.optional(),
    /** The branch as the bundle names it, when restored onto another name. */
    bundleRef: z.string().min(1).optional(),
    /** The folder an imported session worked in on its Mac; the
     *  conversation's working directories move from it to the worktree. */
    originWorktree: z.string().startsWith("/").optional(),
    /** The session's model, recorded before it relaunches, as POST
     *  /workspaces/{id}/model takes it: through a gateway on its key, or
     *  neither. Absent: its agent's own default. */
    model: z
      .object({
        model: z.string().min(1).max(100),
        gateway: z.string().min(1).optional(),
        token: CredentialToken.optional(),
        effort: z.string().min(1).optional(),
      })
      .refine((v) => (v.gateway === undefined) === (v.token === undefined), {
        message: "a gateway needs its key, and only a gateway takes one",
        path: ["token"],
      })
      .optional(),
    /** A session of several repositories (AGENT_FEATURE_MULTI_REPO_SNAPSHOTS):
     *  each restored in its folder off its mirror, on the box already. */
    repos: CreateWorkspaceRequest.shape.repos,
  })
  .refine((v) => coversExactly(v.downloads.map((d) => d.artifact), RESTORE_ARTIFACTS, OPTIONAL_ARTIFACTS), {
    message: "restore downloads must cover exactly bundle, patch, and conversation (and may add a rollout)",
    path: ["downloads"],
  });
export type RestoreWorkspaceRequest = z.infer<typeof RestoreWorkspaceRequest>;

/** What a restore answers: the session's worktree on the box, as create
 *  answers. Absent from agents before it was reported. */
export const RestoreWorkspaceResult = z.object({
  worktree: z.string().startsWith("/").optional(),
});
export type RestoreWorkspaceResult = z.infer<typeof RestoreWorkspaceResult>;

export const ErrorCode = z.enum([
  "WORKSPACE_NOT_FOUND",
  "UNAUTHORIZED",
  "AGENT_UNREACHABLE",
  "INVALID_REQUEST",
  "INTERNAL",
  // A model switch: an unknown session, or one that can't switch right now.
  "NOT_FOUND",
  "CONFLICT",
  // A session credential on an engine that runs sessions on its own login.
  "UNSUPPORTED",
  // A chat (?chat=) the session doesn't have on this box (AGENT_FEATURE_CHATS).
  "CHAT_NOT_FOUND",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ---------------------------------------------------------------------------
// Workspace Summary — the canonical, cross-milestone summary of a Workspace
// Session. Frozen jointly with docs/architecture/m4-plan.md (the M4 Snapshot
// manifest embeds this same shape). Emitted live during a Session and
// snapshotted into the archive manifest at teardown.
//
// M3 owns the type definition (this module + the Go equivalent in
// runtime-agent/internal/protocol). Every other consumer (Mission Engine,
// M4 archive/restore, the Runtime SDK, notifications, analytics) imports or
// mirrors the shape — they do not redefine it.
// ---------------------------------------------------------------------------

export const WorkspaceState = z.enum([
  "starting",
  "running",
  "exited",
  "archived",
  "degraded",
]);
export type WorkspaceState = z.infer<typeof WorkspaceState>;

export const WorkspaceSummary = z.object({
  state: WorkspaceState,
  /** RFC3339 UTC — when the session first started. */
  startedAt: z.string(),
  /** RFC3339 UTC when the session ended, or null while it's still running. */
  endedAt: z.string().nullable(),
  /** Wall-clock (endedAt || now) − startedAt, in whole seconds. */
  duration: z.number().int().nonnegative(),
  /** RFC3339 UTC of the most recent activity we've observed (message, tool result, …). */
  lastActivity: z.string(),
  /** Cumulative token usage across all assistant turns in this session.
   *  Numeric-only by design (interoperable with M4's placeholder validator
   *  and Mission Engine's expected shape); `service_tier` stays on the
   *  standalone `TokenUsage` event where per-turn detail belongs. */
  tokenUsage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
  }),
  /** Count of paths with any diff (staged + unstaged + untracked). */
  changedFiles: z.number().int().nonnegative(),
  /** Sorted union of paths this session has ever touched (committed or WIP). */
  filesTouched: z.array(z.string()),
  /** Commits made on this workspace's branch relative to the base branch. */
  commitCount: z.number().int().nonnegative(),
  /** The most recent assistant `text` content block, or null if none yet. */
  lastAssistantMessage: z.string().nullable(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

/** The workspace claim of the only token that may ask about the whole box
 *  (GET /workspaces, GET /activity): no real workspace can have it. */
export const LISTING_WORKSPACE_ID = "*";

/** One local session the agent on a user's Mac knows (GET /workspaces). */
export const LocalSession = z.object({
  workspaceId: z.string(),
  name: z.string(),
  title: z.string(),
  folder: z.string(),
  worktree: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  inPlace: z.boolean(),
  createdAt: z.string(),
  lastActiveAt: z.string().optional(),
  running: z.boolean(),
  model: z.string().optional(),
  gateway: z.string().optional(),
  /** The session's agent; omitted is Claude (and from agents before agents). */
  agent: AgentName.optional(),
});
export type LocalSession = z.infer<typeof LocalSession>;

/** GET /activity: the box's most recent activity in any session or from a
 *  user, and whether Claude is mid-turn anywhere. An idle box is paused. */
export const Activity = z.object({
  /** RFC3339 UTC. */
  lastActivity: z.string(),
  turnInProgress: z.boolean(),
});
export type Activity = z.infer<typeof Activity>;

// ---------------------------------------------------------------------------
// Session attachment — the browser's handle to one Workspace Session. Returned
// by POST /api/workspaces/[id]/session. Each URL already contains the short-
// lived Runtime token (5-min TTL); refresh by re-calling the endpoint on close.
// See docs/architecture/session-contract.md.
// ---------------------------------------------------------------------------

export const SessionUrls = z.object({
  ptyUrl: z.string().url(),
  eventsUrl: z.string().url().optional(),
  /** Snapshot of the Workspace Summary at attach time; polled at
   *  `GET /api/workspaces/[id]/summary` for updates. */
  summary: WorkspaceSummary.optional(),
});
export type SessionUrls = z.infer<typeof SessionUrls>;

// ---------------------------------------------------------------------------
// Conversation events — derived by the agent from Claude's session JSONL,
// NOT parsed from the PTY. Grounded in the real schema (Spike 3/4).
// ---------------------------------------------------------------------------

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking") }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ type: z.literal("tool_result"), toolUseId: z.string(), content: z.unknown() }),
  // An image pasted into Claude's prompt (in its terminal), in Claude's own
  // shape. `data` is base64, left out by the agent past its cap
  // (MaxImageBlockData), and absent from an agent from before it.
  z.object({
    type: z.literal("image"),
    source: z
      .object({ type: z.string().optional(), media_type: z.string().optional(), data: z.string().optional() })
      .optional(),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

/** A model call's tokens, as a reply carries them (ConversationMessage.usage). */
const ReplyUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
});

export const ConversationMessage = z.object({
  t: z.literal("message"),
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  role: z.enum(["user", "assistant"]),
  // The Claude model that produced the turn (assistant only; omitted on user
  // turns). Lets the composer show the model actually in use.
  model: z.string().optional(),
  // Claude's own injected record, not a turn either party typed: a skill's
  // instructions, a system reminder, and the like (`isMeta` in the JSONL). The
  // timeline tucks these behind a disclosure instead of showing them inline.
  meta: z.boolean().optional(),
  // Why the assistant reply stopped, as Claude logs it: "tool_use" while the
  // turn goes on (its words before a tool call are a record of their own),
  // "end_turn" and the like once it's over. Absent from an agent from before
  // it, a user turn, or a log that says none (a Codex translation).
  stopReason: z.string().optional(),
  timestamp: z.string(),
  // Tolerate content blocks the UI doesn't model (e.g. redacted_thinking, a
  // document, or a newer Claude block type): drop the unrenderable ones instead
  // of failing the whole frame ("Events frame did not match AgentEvent
  // schema"). The timeline only renders the known types anyway.
  content: z.array(z.unknown()).transform((blocks) =>
    blocks.flatMap((block) => {
      const parsed = ContentBlock.safeParse(block);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  // The model call's tokens, on an assistant turn whose log has them: how
  // full the context is (the composer's ring). Absent from agents before it.
  usage: ReplyUsage.optional(),
  // The model's context, in tokens, where the log says it (Codex's does,
  // Claude's doesn't: the page then knows it by the model).
  contextWindow: z.number().int().positive().optional(),
  // How much of it the turn's model call used, where the log says it apart
  // from `usage` (a Codex translation, whose usage can sum two calls').
  contextTokens: z.number().int().positive().optional(),
  // "plan" on a prompt sent in plan mode, where the log says so.
  mode: z.literal("plan").optional(),
  // The conversation compacted here (/compact, or the agent's own when its
  // context filled): an assistant record with no content, which a page from
  // before it shows as nothing. `trigger` is "manual" or "auto" where the log
  // says; `preTokens` how full it was.
  compact: z
    .object({
      trigger: z.string().optional(),
      preTokens: z.number().int().nonnegative().optional(),
      // What the summary left, where the log says (Claude Code 2.1.304's).
      postTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

export const TokenUsage = z.object({
  t: z.literal("usage"),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const WorkspaceStateChanged = z.object({
  t: z.literal("state"),
  workspaceId: z.string(),
  state: z.enum(["starting", "running", "exited", "archived", "degraded"]),
});
export type WorkspaceStateChanged = z.infer<typeof WorkspaceStateChanged>;

/** Everything the agent pushes on the conversation/event channel. */
export const AgentEvent = z.discriminatedUnion("t", [
  ConversationMessage,
  TokenUsage,
  WorkspaceStateChanged,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

// ---------------------------------------------------------------------------
// Fixture registry — maps a schema name to its zod schema, so tests (and the
// Go side, by name) can validate the shared golden fixtures.
// ---------------------------------------------------------------------------

export const PROTOCOL_SCHEMAS = {
  RuntimeTokenClaims,
  PtyClientMessage,
  PtyServerMessage,
  CreateWorkspaceRequest,
  SetAuthRequest,
  AgentHealth,
  LocalSession,
  WorkspaceActionRequest,
  ArchiveWorkspaceRequest,
  RestoreWorkspaceRequest,
  ErrorResponse,
  SessionUrls,
  WorkspaceSummary,
  Activity,
  ConversationMessage,
  TokenUsage,
  WorkspaceStateChanged,
  SendMessageRequest,
  CreateChatRequest,
  CompactRequest,
  PlanActionRequest,
  PlanActionResponse,
  WarmRequest,
  WarmStatus,
  ProvideSecretsRequest,
  SetEnvironmentRequest,
  SetAgentConfigRequest,
  SetSkillsRequest,
  SetSkillsResponse,
  SetAgentContextRequest,
  EditorResponse,
  PortsResponse,
  FilesResponse,
  CanvasResponse,
  /** The provider's own ports on every box (lib/runtime/box-ports.ts and the
   *  agent's ports package each hold the list, checked against this). */
  ProviderPorts: z.array(z.number().int()),
  /** The desktop's ports on a box, likewise never listed nor linked
   *  (lib/runtime/box-ports.ts and the agent's ports package). */
  DesktopPorts: z.array(z.number().int()),
  /** The variables a session's environment may not set; lib/imports/
   *  environment.ts and the agent each hold the list, checked against this. */
  ReservedEnv: z.array(z.string()),
} as const;

export type ProtocolSchemaName = keyof typeof PROTOCOL_SCHEMAS;

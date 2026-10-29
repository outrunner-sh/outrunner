/**
 * Typed client for the runtime-agent, used by the Next control plane. Control
 * calls go server-to-server over the standard Daytona preview URL (with the
 * preview-token header + a Runtime token); the browser terminal connects
 * directly to the signed preview URL, so `ptyUrl` just builds that address.
 *
 * Every response is validated against the frozen protocol — no ad-hoc JSON.
 */

import {
  Activity,
  AgentHealth,
  AnswerRequest,
  ProvideSecretsRequest,
  WarmRequest,
  WarmStatus,
  ArchiveWorkspaceRequest,
  ChangedFileDiffResponse,
  ChangesResponse,
  ChatId,
  CompactRequest,
  CreateChatRequest,
  CreateWorkspaceRequest,
  PlanActionRequest,
  PlanActionResponse,
  EditorResponse,
  ErrorResponse,
  CanvasResponse,
  FilesResponse,
  LISTING_WORKSPACE_ID,
  MAIN_CHAT,
  PortsResponse,
  RestoreWorkspaceRequest,
  RestoreWorkspaceResult,
  RewindRequest,
  RewindResponse,
  type RuntimeTokenClaims,
  SendMessageRequest,
  SetAgentConfigRequest,
  SetAgentContextRequest,
  SetAuthRequest,
  SetEnvironmentRequest,
  SetSkillsRequest,
  SetSkillsResponse,
  WorkspaceSummary,
} from "@/lib/runtime/agent-protocol";
import { mintRuntimeToken } from "@/lib/runtime/runtime-token";
import type { AgentEndpoint } from "@/lib/runtime/sandbox/backend";
import type { SetModelRequest } from "@/lib/runtime/session-models";
import {
  parseManifest,
  type SnapshotManifest,
} from "@/lib/runtime/snapshot/manifest";

/** Everything needed to reach one Runtime Computer's agent: where its sandbox
 *  provider exposes it ({@link AgentEndpoint}) and the per-computer Runtime
 *  secret used to mint Runtime tokens. */
export type AgentTarget = AgentEndpoint & { secret: string };

/** The authorized identity for a workspace connection (exp is filled by mint). */
export type WorkspaceIdentity = Omit<RuntimeTokenClaims, "exp">;

type FetchFn = typeof fetch;

/**
 * Cap every agent round-trip. A remote box behind the Daytona proxy can stall
 * without ever erroring; the session-attach route awaits `workspaceSummary`, so
 * an unbounded fetch there would leave the caller (and the composer) hung with
 * no error to surface. Fail fast instead so callers can degrade or retry.
 */
const AGENT_REQUEST_TIMEOUT_MS = 12_000;
/** Opening the editor: the agent waits up to 15 seconds for it to come up
 *  before saying it's still starting. */
const EDITOR_TIMEOUT_MS = 25_000;

/** How long a Canvas file (up to 5 MB) may take to arrive, body and all. */
const CANVAS_FILE_TIMEOUT_MS = 30_000;

/**
 * Archive/restore do real snapshot I/O on the box — the agent uploads or
 * downloads the tree + conversation and rebuilds the worktree — which routinely
 * outruns the 12s cap above. Give those a much longer client deadline so a
 * valid long-running restore isn't aborted and reported as a failure.
 */
const AGENT_LIFECYCLE_TIMEOUT_MS = 180_000;

/**
 * Start and resume return once Claude's prompt is up, which the agent waits up
 * to 15s for. Outlast that cap, so a slow launch the agent still reports as
 * started isn't reported here as a failure.
 */
const AGENT_START_TIMEOUT_MS = 30_000;

/**
 * A send waits for Claude to record the prompt (about 8s of Enter presses),
 * and the agent gives a hung tmux up to 30s before letting go. Outlast that,
 * so a slow send the agent still delivers isn't reported here as unreachable.
 */
const AGENT_SEND_TIMEOUT_MS = 35_000;

/**
 * A model switch checks the session (up to 10s on the agent) and relaunches
 * Claude on the new model (up to 60s), so it outlasts both.
 */
const AGENT_MODEL_SWITCH_TIMEOUT_MS = 90_000;

/** A non-2xx agent answer. `error` is the agent's error envelope; absent when
 *  the answer was not one (such as a route an older agent does not have). */
export class AgentRequestError extends Error {
  readonly status: number;
  readonly error?: ErrorResponse["error"];

  constructor(status: number, error?: ErrorResponse["error"]) {
    super(error ? `agent ${error.code}: ${error.message}` : `agent request failed (${status})`);
    this.name = "AgentRequestError";
    this.status = status;
    this.error = error;
  }
}

export class InvalidSnapshotManifestError extends Error {
  constructor(cause: unknown) {
    super("The agent returned an invalid Snapshot manifest.", { cause });
    this.name = "InvalidSnapshotManifestError";
  }
}

/** The query naming a chat on a session's route or stream (AGENT_FEATURE_CHATS):
 *  none for its main chat, which every agent serves unnamed. */
export function chatQuery(chat: string | undefined, join: "?" | "&" = "?"): string {
  return chat && chat !== MAIN_CHAT ? `${join}chat=${encodeURIComponent(chat)}` : "";
}

export class AgentClient {
  private readonly target: AgentTarget;
  private readonly fetchFn: FetchFn;

  constructor(target: AgentTarget, fetchFn: FetchFn = fetch) {
    this.target = target;
    this.fetchFn = fetchFn;
  }

  async createWorkspace(
    req: CreateWorkspaceRequest,
    identity: WorkspaceIdentity,
  ): Promise<{ worktree: string }> {
    const body = CreateWorkspaceRequest.parse(req);
    return this.post("/workspaces", identity, body) as Promise<{
      worktree: string;
    }>;
  }

  /** Start the session's agent, or one of its chats' (`chat`). */
  startWorkspace(identity: WorkspaceIdentity, chat?: string): Promise<unknown> {
    return this.post(
      `/workspaces/${identity.workspaceId}/start${chatQuery(chat)}`,
      identity,
      undefined,
      AGENT_START_TIMEOUT_MS,
    );
  }

  stopWorkspace(identity: WorkspaceIdentity, chat?: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/stop${chatQuery(chat)}`, identity);
  }

  /**
   * Deliver a user prompt to the workspace's agent session (jcode engine). The
   * reply streams back on the Conversation SSE; this just starts the turn.
   */
  async sendMessage(
    identity: WorkspaceIdentity,
    content: string,
    options: Omit<SendMessageRequest, "content"> = {},
    chat?: string,
  ): Promise<unknown> {
    // A mode only where one is asked for: a prompt that names none is the
    // body every agent has always taken.
    const body = SendMessageRequest.parse({ content, ...options });
    return this.post(`/workspaces/${identity.workspaceId}/message${chatQuery(chat)}`, identity, body, AGENT_SEND_TIMEOUT_MS);
  }

  /** Make a chat in the session, forked or afresh, and start it
   *  (CreateChatRequest). An agent from before chats answers 404 with no
   *  error envelope. */
  createChat(identity: WorkspaceIdentity, req: CreateChatRequest): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/chats`, identity, CreateChatRequest.parse(req), AGENT_START_TIMEOUT_MS);
  }

  /** Cut a chat's conversation back to just before its prompt `uuid`, for
   *  an edit of it to be sent in its place (RewindRequest). Refused (409
   *  CONFLICT) while the agent works; 400 for what isn't a prompt. */
  async rewind(identity: WorkspaceIdentity, req: RewindRequest, chat?: string): Promise<RewindResponse> {
    const raw = await this.post(`/workspaces/${identity.workspaceId}/rewind${chatQuery(chat)}`, identity, RewindRequest.parse(req), AGENT_MODEL_SWITCH_TIMEOUT_MS);
    return RewindResponse.parse(raw);
  }

  /** End one of the session's chats and forget it; one already gone is fine. */
  deleteChat(identity: WorkspaceIdentity, chat: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/chats/${encodeURIComponent(ChatId.parse(chat))}/delete`, identity);
  }

  /** Approve the plan the session's agent waits on (PlanActionRequest). */
  async approvePlan(identity: WorkspaceIdentity, chat?: string): Promise<PlanActionResponse> {
    const raw = await this.post(`/workspaces/${identity.workspaceId}/plan${chatQuery(chat)}`, identity, PlanActionRequest.parse({ action: "approve" }), AGENT_SEND_TIMEOUT_MS);
    return PlanActionResponse.parse(raw);
  }

  /** Compact the session's conversation, as /compact does in its terminal.
   *  Answers once the compaction is under way; the stream shows it done. */
  async compact(identity: WorkspaceIdentity, req: CompactRequest = {}, chat?: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/compact${chatQuery(chat)}`, identity, CompactRequest.parse(req), AGENT_SEND_TIMEOUT_MS);
  }

  /**
   * Have the box's editor (code-server) running, and say where: its port and
   * the session's folder. Null while it is still being installed or started
   * (the first open on a box installs it): ask again shortly.
   */
  async openEditor(identity: WorkspaceIdentity): Promise<EditorResponse | null> {
    const raw = await this.post(`/workspaces/${identity.workspaceId}/editor`, identity, undefined, EDITOR_TIMEOUT_MS);
    if ((raw as { result?: unknown } | null)?.result === "starting") return null;
    return EditorResponse.parse(raw);
  }

  /** The servers running on the session's box, for its owner to open. */
  async listPorts(identity: WorkspaceIdentity): Promise<PortsResponse["ports"]> {
    return PortsResponse.parse(await this.get(`/workspaces/${identity.workspaceId}/ports`, identity)).ports;
  }

  /** The session's changed files since its base branch, read by git on the
   *  box: one request, where reading them from outside takes one per git
   *  command. An agent from before this answers 404 with no error envelope. */
  async listChanges(identity: WorkspaceIdentity): Promise<ChangesResponse["files"]> {
    return ChangesResponse.parse(await this.get(`/workspaces/${identity.workspaceId}/changes`, identity)).files;
  }

  /** The session's files for the composer's @ mentions, its changed ones
   *  first. An agent from before this answers 404 with no error envelope. */
  async listFiles(identity: WorkspaceIdentity): Promise<FilesResponse> {
    return FilesResponse.parse(await this.get(`/workspaces/${identity.workspaceId}/files`, identity));
  }

  /** The session's Canvas: its folder on the box, and its files. An agent
   *  from before it answers 404 with no error envelope. */
  async listCanvas(identity: WorkspaceIdentity): Promise<CanvasResponse> {
    return CanvasResponse.parse(await this.get(`/workspaces/${identity.workspaceId}/canvas`, identity));
  }

  /** One file of the session's Canvas, as bytes: 400 INVALID_REQUEST for a
   *  path that names none, 404 NOT_FOUND for none, 413 TOO_LARGE past 5 MB. */
  async readCanvasFile(identity: WorkspaceIdentity, path: string): Promise<Uint8Array> {
    // Up to 5 MB through the provider's proxy: the window covers reading
    // the body too, so it's wider than a call's.
    const response = await this.send(
      "GET",
      `/workspaces/${identity.workspaceId}/canvas/file?path=${encodeURIComponent(path)}`,
      identity,
      undefined,
      CANVAS_FILE_TIMEOUT_MS,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  /** One changed file's bounded diff, from the same base: 400 INVALID_REQUEST
   *  for a path that isn't one, 404 NOT_FOUND for a file not in the changes. */
  async changedFileDiff(identity: WorkspaceIdentity, path: string): Promise<string> {
    const query = `?path=${encodeURIComponent(path)}`;
    return ChangedFileDiffResponse.parse(await this.get(`/workspaces/${identity.workspaceId}/changes${query}`, identity)).diff;
  }

  /** Stop the turn the workspace's session is running, as Escape does in its
   *  terminal; a session not running one is already stopped. */
  interrupt(identity: WorkspaceIdentity, chat?: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/interrupt${chatQuery(chat)}`, identity);
  }

  /** Answer the questions the workspace's session is waiting on (its agent's
   *  ask_user call). `questions` are the call's, as the transcript has them:
   *  the agent refuses an answer to any it isn't waiting on (409 CONFLICT). */
  answer(identity: WorkspaceIdentity, req: AnswerRequest, chat?: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/answer${chatQuery(chat)}`, identity, AnswerRequest.parse(req));
  }

  /** Answer the request for secrets the workspace's session is waiting on
   *  (its agent's request_secrets call): the values go into its session,
   *  never into a log. An answer to a request it isn't waiting on is 409
   *  CONFLICT. */
  provideSecrets(identity: WorkspaceIdentity, req: ProvideSecretsRequest, chat?: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/secrets${chatQuery(chat)}`, identity, ProvideSecretsRequest.parse(req));
  }

  resumeWorkspace(identity: WorkspaceIdentity, chat?: string): Promise<unknown> {
    return this.post(
      `/workspaces/${identity.workspaceId}/resume${chatQuery(chat)}`,
      identity,
      undefined,
      AGENT_START_TIMEOUT_MS,
    );
  }

  /** Give the workspace's session its own credential, applied at its next
   *  launch. An agent from before per-session credentials answers 404 with no
   *  error envelope; one that doesn't know the session, 404 NOT_FOUND. */
  setAuth(identity: WorkspaceIdentity, req: SetAuthRequest, chat?: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/auth${chatQuery(chat)}`, identity, SetAuthRequest.parse(req));
  }

  /** Install the user's own agent setup on the computer. */
  setAgentConfig(identity: WorkspaceIdentity, req: SetAgentConfigRequest): Promise<unknown> {
    return this.post("/config", identity, SetAgentConfigRequest.parse(req), AGENT_LIFECYCLE_TIMEOUT_MS);
  }

  /** Install the project's skills on the computer: what it installed, and
   *  what it couldn't. */
  async setSkills(identity: WorkspaceIdentity, req: SetSkillsRequest): Promise<SetSkillsResponse> {
    return SetSkillsResponse.parse(await this.post("/skills", identity, SetSkillsRequest.parse(req), AGENT_LIFECYCLE_TIMEOUT_MS));
  }

  /** Give every session on the computer what it reads besides its
   *  orientation: the user's and org's learnings (lib/runtime/agent-context.ts). */
  setAgentContext(identity: WorkspaceIdentity, req: SetAgentContextRequest): Promise<unknown> {
    return this.post("/agent-context", identity, SetAgentContextRequest.parse(req));
  }

  /** Give the session its project's environment, before it launches. */
  setEnvironment(identity: WorkspaceIdentity, req: SetEnvironmentRequest): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/environment`, identity, SetEnvironmentRequest.parse(req));
  }

  /** What the box's agent can run (GET /health, which needs no token; the
   *  identity's is sent anyway). */
  async health(identity: WorkspaceIdentity): Promise<AgentHealth> {
    return AgentHealth.parse(await this.get("/health", identity));
  }

  /** Switch the workspace's session to another model; the agent relaunches
   *  Claude on it with the conversation continued. */
  setModel(identity: WorkspaceIdentity, req: SetModelRequest, chat?: string): Promise<unknown> {
    return this.post(
      `/workspaces/${identity.workspaceId}/model${chatQuery(chat)}`,
      identity,
      req,
      AGENT_MODEL_SWITCH_TIMEOUT_MS,
    );
  }

  /**
   * Archive the workspace: the agent produces the Snapshot artifacts and uploads
   * them through the supplied signed URLs (manifest last), returning the manifest
   * it assembled. Validated against the manifest schema — the same contract the
   * db row caches — so a malformed manifest fails here, not downstream.
   */
  async archiveWorkspace(
    identity: WorkspaceIdentity,
    req: ArchiveWorkspaceRequest,
  ): Promise<SnapshotManifest> {
    const body = ArchiveWorkspaceRequest.parse(req);
    const raw = await this.post(
      `/workspaces/${identity.workspaceId}/archive`,
      identity,
      body,
      AGENT_LIFECYCLE_TIMEOUT_MS,
    );
    try {
      return parseManifest(raw);
    } catch (error) {
      throw new InvalidSnapshotManifestError(error);
    }
  }

  /**
   * Restore an archived workspace: the agent downloads the tree + conversation
   * via the supplied signed URLs, rebuilds and verifies the worktree, and
   * relaunches Claude with `--continue`. Rejects (agent 500) if verification
   * fails — Claude is not booted into a broken restore.
   */
  /** Restore an archived session. The worktree is undefined from an agent
   *  that doesn't report it (or reports something unreadable): the restore
   *  itself still succeeded. */
  async restoreWorkspace(
    identity: WorkspaceIdentity,
    req: RestoreWorkspaceRequest,
  ): Promise<RestoreWorkspaceResult> {
    const body = RestoreWorkspaceRequest.parse(req);
    const raw = await this.post(
      `/workspaces/${identity.workspaceId}/restore`,
      identity,
      body,
      AGENT_LIFECYCLE_TIMEOUT_MS,
    );
    const parsed = RestoreWorkspaceResult.safeParse(raw);
    return parsed.success ? parsed.data : {};
  }

  destroyWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/destroy`, identity);
  }

  /**
   * Fetch the current WorkspaceSummary for a workspace. Cheap enough for
   * Mission Engine's polling cadence; the agent maintains the event-driven
   * fields in memory and shells out to git for the rest at request time.
   */
  async workspaceSummary(identity: WorkspaceIdentity, chat?: string): Promise<WorkspaceSummary> {
    const raw = await this.get(`/workspaces/${identity.workspaceId}/summary${chatQuery(chat)}`, identity);
    return WorkspaceSummary.parse(raw);
  }

  /**
   * The box's activity: when anything last happened on it, and whether Claude
   * is mid-turn, for pausing an idle box. Box-wide, so it rides the listing
   * token rather than one workspace's. An agent from before this route answers
   * 404 (an {@link AgentRequestError} with no error envelope).
   */
  async activity(box: Omit<WorkspaceIdentity, "workspaceId">): Promise<Activity> {
    const raw = await this.get("/activity", { ...box, workspaceId: LISTING_WORKSPACE_ID });
    return Activity.parse(raw);
  }

  /** Start warming a ready box (POST /warm): box-wide, so the listing
   *  token. A box warming already answers 409 CONFLICT. */
  startWarm(box: Omit<WorkspaceIdentity, "workspaceId">, req: WarmRequest): Promise<unknown> {
    return this.post("/warm", { ...box, workspaceId: LISTING_WORKSPACE_ID }, WarmRequest.parse(req));
  }

  /** How the box's warming went (GET /warm). */
  async warmStatus(box: Omit<WorkspaceIdentity, "workspaceId">): Promise<WarmStatus> {
    return WarmStatus.parse(await this.get("/warm", { ...box, workspaceId: LISTING_WORKSPACE_ID }));
  }

  /**
   * The `wss://` URL the browser opens for the live terminal: the provider's
   * browser-ready host (any credential already in it, so no headers) plus a
   * short Runtime token the agent verifies.
   */
  ptyUrl(identity: WorkspaceIdentity, chat?: string): string {
    const base = this.target.wsBaseUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/pty?token=${encodeURIComponent(token)}${chatQuery(chat, "&")}`;
  }

  /**
   * The `wss://` URL the browser opens for the Conversation event stream. Same
   * signed host and short-lived Runtime token as {@link ptyUrl}. This rides a
   * WebSocket (not SSE) because an embedded WKWebView buffers `text/event-stream`
   * responses — the PTY WS streams live there, but EventSource does not — so the
   * agent serves the same event sequence over `/events-ws`.
   *
   * Resume is via `?lastEventId=<seq>`; the agent starts its watcher at that
   * JSONL byte offset so no event is duplicated or skipped across reconnects.
   */
  eventsUrl(identity: WorkspaceIdentity, chat?: string): string {
    const base = this.target.wsBaseUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/events-ws?token=${encodeURIComponent(token)}${chatQuery(chat, "&")}`;
  }

  /**
   * The `https://` SSE URL for the still-served `/events` endpoint. The browser
   * uses the WebSocket {@link eventsUrl}; this exists for non-browser callers
   * that speak plain SSE (the Daytona verify script), since `fetch()` cannot
   * open a `wss:` URL.
   */
  eventsSseUrl(identity: WorkspaceIdentity, chat?: string): string {
    const base = this.target.wsBaseUrl.replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/events?token=${encodeURIComponent(token)}${chatQuery(chat, "&")}`;
  }

  private async post(
    path: string,
    identity: WorkspaceIdentity,
    body?: unknown,
    timeoutMs: number = AGENT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.request("POST", path, identity, body, timeoutMs);
  }

  private async get(path: string, identity: WorkspaceIdentity): Promise<unknown> {
    return this.request("GET", path, identity);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    identity: WorkspaceIdentity,
    body?: unknown,
    timeoutMs: number = AGENT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return safeJson(await (await this.send(method, path, identity, body, timeoutMs)).text());
  }

  /** The agent's answer to a call, once it's a success: its refusal is
   *  thrown as an AgentRequestError. */
  private async send(
    method: "GET" | "POST",
    path: string,
    identity: WorkspaceIdentity,
    body?: unknown,
    timeoutMs: number = AGENT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const token = mintRuntimeToken(identity, this.target.secret);
    const response = await this.fetchFn(
      `${this.target.controlBaseUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          ...(body !== undefined && { "content-type": "application/json" }),
          // The provider's proxy headers first, so they can never replace ours.
          ...this.target.controlHeaders,
          authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(safeJson(await response.text()));
      throw new AgentRequestError(response.status, parsed.success ? parsed.data.error : undefined);
    }
    return response;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

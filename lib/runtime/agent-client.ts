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
  ArchiveWorkspaceRequest,
  CreateWorkspaceRequest,
  EditorResponse,
  ErrorResponse,
  LISTING_WORKSPACE_ID,
  PortsResponse,
  RestoreWorkspaceRequest,
  type RuntimeTokenClaims,
  SetAgentConfigRequest,
  SetAuthRequest,
  SetEnvironmentRequest,
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

  startWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(
      `/workspaces/${identity.workspaceId}/start`,
      identity,
      undefined,
      AGENT_START_TIMEOUT_MS,
    );
  }

  stopWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/stop`, identity);
  }

  /**
   * Deliver a user prompt to the workspace's agent session (jcode engine). The
   * reply streams back on the Conversation SSE; this just starts the turn.
   */
  sendMessage(identity: WorkspaceIdentity, content: string): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/message`, identity, {
      content,
    });
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

  /** Stop the turn the workspace's session is running, as Escape does in its
   *  terminal; a session not running one is already stopped. */
  interrupt(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/interrupt`, identity);
  }

  /** Answer the questions the workspace's session is waiting on (its agent's
   *  ask_user call). `questions` are the call's, as the transcript has them:
   *  the agent refuses an answer to any it isn't waiting on (409 CONFLICT). */
  answer(identity: WorkspaceIdentity, req: AnswerRequest): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/answer`, identity, AnswerRequest.parse(req));
  }

  resumeWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(
      `/workspaces/${identity.workspaceId}/resume`,
      identity,
      undefined,
      AGENT_START_TIMEOUT_MS,
    );
  }

  /** Give the workspace's session its own credential, applied at its next
   *  launch. An agent from before per-session credentials answers 404 with no
   *  error envelope; one that doesn't know the session, 404 NOT_FOUND. */
  setAuth(identity: WorkspaceIdentity, req: SetAuthRequest): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/auth`, identity, SetAuthRequest.parse(req));
  }

  /** Install the user's own agent setup on the computer. */
  setAgentConfig(identity: WorkspaceIdentity, req: SetAgentConfigRequest): Promise<unknown> {
    return this.post("/config", identity, SetAgentConfigRequest.parse(req), AGENT_LIFECYCLE_TIMEOUT_MS);
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
  setModel(identity: WorkspaceIdentity, req: SetModelRequest): Promise<unknown> {
    return this.post(
      `/workspaces/${identity.workspaceId}/model`,
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
    return parseManifest(raw);
  }

  /**
   * Restore an archived workspace: the agent downloads the tree + conversation
   * via the supplied signed URLs, rebuilds and verifies the worktree, and
   * relaunches Claude with `--continue`. Rejects (agent 500) if verification
   * fails — Claude is not booted into a broken restore.
   */
  async restoreWorkspace(
    identity: WorkspaceIdentity,
    req: RestoreWorkspaceRequest,
  ): Promise<unknown> {
    const body = RestoreWorkspaceRequest.parse(req);
    return this.post(
      `/workspaces/${identity.workspaceId}/restore`,
      identity,
      body,
      AGENT_LIFECYCLE_TIMEOUT_MS,
    );
  }

  destroyWorkspace(identity: WorkspaceIdentity): Promise<unknown> {
    return this.post(`/workspaces/${identity.workspaceId}/destroy`, identity);
  }

  /**
   * Fetch the current WorkspaceSummary for a workspace. Cheap enough for
   * Mission Engine's polling cadence; the agent maintains the event-driven
   * fields in memory and shells out to git for the rest at request time.
   */
  async workspaceSummary(identity: WorkspaceIdentity): Promise<WorkspaceSummary> {
    const raw = await this.get(`/workspaces/${identity.workspaceId}/summary`, identity);
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

  /**
   * The `wss://` URL the browser opens for the live terminal: the provider's
   * browser-ready host (any credential already in it, so no headers) plus a
   * short Runtime token the agent verifies.
   */
  ptyUrl(identity: WorkspaceIdentity): string {
    const base = this.target.wsBaseUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/pty?token=${encodeURIComponent(token)}`;
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
  eventsUrl(identity: WorkspaceIdentity): string {
    const base = this.target.wsBaseUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/events-ws?token=${encodeURIComponent(token)}`;
  }

  /**
   * The `https://` SSE URL for the still-served `/events` endpoint. The browser
   * uses the WebSocket {@link eventsUrl}; this exists for non-browser callers
   * that speak plain SSE (the Daytona verify script), since `fetch()` cannot
   * open a `wss:` URL.
   */
  eventsSseUrl(identity: WorkspaceIdentity): string {
    const base = this.target.wsBaseUrl.replace(/\/$/, "");
    const token = mintRuntimeToken(identity, this.target.secret);
    return `${base}/events?token=${encodeURIComponent(token)}`;
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

    const text = await response.text();
    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(safeJson(text));
      throw new AgentRequestError(response.status, parsed.success ? parsed.data.error : undefined);
    }
    return safeJson(text);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

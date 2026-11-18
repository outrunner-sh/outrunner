/**
 * Cursor's Cloud Agents API (api.cursor.com/v1/agents), spoken at
 * /api/v1/agents, so a script written for it moves by changing its address
 * and key alone. The part with no network: Cursor's requests read as
 * Outrunner's (POST /workspaces, POST /workspaces/{id}/messages), and
 * Outrunner's sessions, runs and stream events said in Cursor's words.
 * lib/api/cursor.deps.ts calls the sessions' own code with them.
 *
 * An agent is a session, its id the session's. A run is one of its runs
 * (lib/api/runs.ts), named by its place among them (`run-1` is the
 * session's first prompt): a run's own id is its prompt's event, unknown
 * until its box has logged it, while Cursor answers a create or a follow-up
 * with the run's id at once.
 */

import type { Run, RunStatus, Usage } from "@/lib/api/runs";
import type { StreamEvent } from "@/lib/api/stream";
import { MEDIA_TYPES, type MediaContentType } from "@/lib/media/media";
import { isObject } from "@/lib/is-object";

export type CursorRunStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED";
export type CursorAgentStatus = "ACTIVE" | "IDLE" | "ARCHIVED";

const RUN_STATUS: Record<RunStatus, CursorRunStatus> = {
  running: "RUNNING",
  // Cursor's agents never ask: still under way, with `pendingInput` to say why.
  needs_input: "RUNNING",
  finished: "FINISHED",
  cancelled: "CANCELLED",
  error: "ERROR",
};

export function cursorRunStatus(status: RunStatus): CursorRunStatus {
  return RUN_STATUS[status];
}

/** A run's id as the agents API names it: its place among the session's runs. */
export function cursorRunId(number: number): string {
  return `run-${number}`;
}

/** The run an id names: by its place (`run-2`), or by Outrunner's own id
 *  (its prompt's event, as /workspaces/{id}/runs answers it); null for neither. */
export function runRef(id: string): { number: number } | { id: string } | null {
  const numbered = /^run-([1-9]\d{0,8})$/.exec(id);
  if (numbered) return { number: Number(numbered[1]) };
  return /^\d{1,15}$/.test(id) ? { id } : null;
}

/** The run of `runs` a ref names. */
export function findRun(runs: readonly Run[], ref: { number: number } | { id: string }): Run | undefined {
  return runs.find((r) => ("number" in ref ? r.number === ref.number : r.id === ref.id));
}

/** A session's id from an agent's: Cursor's are `bc-<uuid>`, and either is taken. */
export function sessionIdOf(agentId: string): string {
  return agentId.replace(/^bc-/, "");
}

/** The ids Cursor names an effort by among a model's `params`. */
export const EFFORT_PARAMETERS = ["effort", "reasoning_effort", "thinking"];

/** Model ids of Cursor's own, with no model here: the session starts on
 *  the caller's default, as with none named. */
export function isCursorOnlyModel(id: string): boolean {
  return /^(composer(-.*)?|default|auto|cursor-.*)$/i.test(id);
}

/** Outrunner's own create fields, taken beside Cursor's for what Cursor's
 *  request has no word for (a project of several repositories, an effort). */
const OUTRUNNER_CREATE_FIELDS = [
  "project_id",
  "environment_id",
  "provider",
  "effort",
  "agent",
  "size",
  "branch",
  "webhook_url",
  "attachment_ids",
] as const;

/** What a follow-up can't change of a session already started, and where
 *  it's set instead. */
const KEPT_ELSEWHERE: Record<string, string> = {
  mcpServers:
    "A run can't add MCP servers to an agent already started: give them as it's created (`mcpServers`), or add them to its project (POST /api/v1/environments/{id}/mcp-servers).",
};

/** Cursor's per-agent fields, as POST /workspaces names them. */
const SESSION_OWN = { envVars: "env", mcpServers: "mcp_servers", customSubagents: "subagents" } as const;

/** Cursor's `prompt` (`{ text, images }`, or plain text) as text and images,
 *  or the reason it's refused. */
function promptOf(value: unknown): { text: string; images?: unknown } | string {
  if (typeof value === "string") return { text: value };
  if (!isObject(value)) return "`prompt` is `{ text, images? }`.";
  if (value.text !== undefined && typeof value.text !== "string") return "`prompt.text` is text.";
  return { text: (value.text as string | undefined) ?? "", ...(value.images !== undefined && { images: value.images }) };
}

function refusedField(raw: Record<string, unknown>): string | null {
  for (const [key, message] of Object.entries(KEPT_ELSEWHERE)) {
    const value = raw[key];
    const empty = value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);
    if (!empty) return message;
  }
  return null;
}

/** The effort Cursor's `model.params` names (`[{ id: "effort", value }]`, as
 *  GET /models' `items` offer it), or the reason it's refused. */
function effortOf(params: unknown): string | undefined | { refused: string } {
  if (params === undefined || params === null) return undefined;
  if (!Array.isArray(params) || !params.every(isObject)) return { refused: "`model.params` is a list of `{ id, value }`." };
  const effort = (params as Record<string, unknown>[]).find((p) => EFFORT_PARAMETERS.includes(String(p.id)));
  if (!effort) return undefined;
  return typeof effort.value === "string" && effort.value ? effort.value : { refused: "The effort's `value` is one of the model's efforts, from GET /api/v1/models." };
}

/** A create in Cursor's words (POST /v1/agents), as POST /workspaces takes
 *  it, with the `agentId` it was sent under (an idempotency key here) and
 *  the project it names (`env.name`, found by lib/api/cursor.deps.ts); or
 *  the reason it's refused. */
export function createFromCursor(
  raw: Record<string, unknown>,
): { body: Record<string, unknown>; agentId: string | null; envName: string | null } | string {
  const prompt = promptOf(raw.prompt);
  if (typeof prompt === "string") return prompt;
  const body: Record<string, unknown> = { prompt: prompt.text };
  if (prompt.images !== undefined) body.images = prompt.images;

  if (raw.model !== undefined && raw.model !== null) {
    const id = typeof raw.model === "string" ? raw.model : isObject(raw.model) ? raw.model.id : undefined;
    if (typeof id !== "string" || !id.trim()) return "`model` is `{ id }`, an id from GET /api/v1/models.";
    if (!isCursorOnlyModel(id.trim())) body.model = id.trim();
    const effort = isObject(raw.model) ? effortOf(raw.model.params) : undefined;
    if (typeof effort === "object") return effort.refused;
    if (effort) body.effort = effort;
  }
  // null is left out, as absent (a Python client's None).
  if (raw.name != null) body.name = raw.name;

  if (raw.repos !== undefined && raw.repos !== null) {
    if (!Array.isArray(raw.repos) || !raw.repos.every(isObject)) return "`repos` is a list of `{ url, startingRef?, prUrl? }`.";
    if (raw.repos.length > 1) {
      return "One repository per agent here: for several, make a project of them in Outrunner and send its `environment_id` instead of `repos`.";
    }
    const repo = raw.repos[0] as Record<string, unknown> | undefined;
    if (repo) {
      if (repo.url != null) body.repo_url = repo.url;
      if (repo.startingRef != null) body.base_branch = repo.startingRef;
      if (repo.prUrl != null) body.pr_url = repo.prUrl;
    }
  }
  if (raw.workOnCurrentBranch !== undefined) body.work_on_current_branch = raw.workOnCurrentBranch;
  if (raw.autoCreatePR !== undefined) body.auto_create_pr = raw.autoCreatePR;
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode !== "agent" && raw.mode !== "plan") return "`mode` is agent or plan.";
    body.plan_mode = raw.mode === "plan";
  }
  if (isObject(raw.webhook) && raw.webhook.url !== undefined) body.webhook_url = raw.webhook.url;

  // Where it runs: Outrunner's own boxes, in the project `env.name` names.
  let envName: string | null = null;
  if (raw.env !== undefined && raw.env !== null) {
    if (!isObject(raw.env)) return "`env` is `{ type, name? }`.";
    if (raw.env.type !== "cloud") {
      return "Agents run on Outrunner's boxes here (`env.type: cloud`); your own machines aren't pooled. Your own Daytona, Modal or Google Cloud is set up in the org's settings.";
    }
    if (raw.env.name !== undefined && raw.env.name !== null) {
      if (typeof raw.env.name !== "string" || !raw.env.name.trim()) return "`env.name` is a project's name.";
      if (Array.isArray(raw.repos) && raw.repos.length) return "Name a project (`env.name`) or `repos`, not both.";
      envName = raw.env.name.trim();
    }
  }
  for (const [cursorKey, key] of Object.entries(SESSION_OWN)) if (raw[cursorKey] !== undefined) body[key] = raw[cursorKey];
  for (const key of OUTRUNNER_CREATE_FIELDS) if (raw[key] !== undefined) body[key] = raw[key];

  let agentId: string | null = null;
  if (raw.agentId !== undefined && raw.agentId !== null) {
    if (typeof raw.agentId !== "string" || !/^[\x21-\x7e]{1,255}$/.test(raw.agentId)) return "`agentId` is 1 to 255 printable characters.";
    agentId = raw.agentId;
  }
  return { body, agentId, envName };
}

/** A follow-up in Cursor's words (POST /v1/agents/{id}/runs), as POST
 *  /workspaces/{id}/messages takes it, and whether it was sent to steer the
 *  run going on; or the reason it's refused. */
export function followUpFromCursor(raw: Record<string, unknown>): { body: Record<string, unknown>; steer: boolean } | string {
  const refused = refusedField(raw);
  if (refused) return refused;
  if (raw.delivery !== undefined && raw.delivery !== null && raw.delivery !== "steer") return "`delivery` is steer, or left out.";
  const prompt = promptOf(raw.prompt);
  if (typeof prompt === "string") return prompt;
  const body: Record<string, unknown> = { content: prompt.text };
  if (prompt.images !== undefined) body.images = prompt.images;
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode !== "agent" && raw.mode !== "plan") return "`mode` is agent or plan.";
    body.mode = raw.mode === "plan" ? "plan" : "build";
  }
  if (raw.attachment_ids !== undefined) body.attachment_ids = raw.attachment_ids;
  return { body, steer: raw.delivery === "steer" };
}

/** A repository's address without its scheme, as Cursor's `git` names it,
 *  from a project's `full_name` (owner/name, or gitlab.com/group/project). */
export function repoAddress(fullName: string): string {
  return /^gitlab\.com\//i.test(fullName) ? fullName : `github.com/${fullName}`;
}

/** The agent's status: archived, or at work (being set up, or on a turn),
 *  or not. `turn` is its turn's state when its box was read; null when not. */
export function cursorAgentStatus(sessionStatus: string, turn: string | null): CursorAgentStatus {
  if (["archiving", "archived", "deleting", "deleted"].includes(sessionStatus)) return "ARCHIVED";
  if (["preparing", "resuming", "restoring"].includes(sessionStatus)) return "ACTIVE";
  return turn === "working" || turn === "needs_input" ? "ACTIVE" : "IDLE";
}

/** A session, as POST and GET /workspaces answer it (lib/api/serialize.ts
 *  workspaceJson), as an agent: its identity, and with `repos`, in full. */
export function cursorAgentJson(
  session: Record<string, unknown>,
  extra: {
    status: CursorAgentStatus;
    latestRunId?: string | null;
    repos?: { fullName: string; startingRef: string | null }[];
    workOnCurrentBranch?: boolean;
    autoCreatePR?: boolean;
  },
): Record<string, unknown> {
  return {
    id: session.id,
    name: session.title ?? null,
    status: extra.status,
    env: { type: "cloud" },
    ...(extra.repos && { repos: extra.repos.map((r) => ({ url: `https://${repoAddress(r.fullName)}`, ...(r.startingRef && { startingRef: r.startingRef }) })) }),
    ...(extra.workOnCurrentBranch !== undefined && { workOnCurrentBranch: extra.workOnCurrentBranch }),
    ...(extra.autoCreatePR !== undefined && { autoCreatePR: extra.autoCreatePR }),
    url: session.url,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    ...(extra.latestRunId !== undefined && { latestRunId: extra.latestRunId }),
  };
}

export type GitBranch = { fullName: string; branch: string | null; prUrl: string | null };

function gitJson(branches: readonly GitBranch[]): Record<string, unknown> {
  return {
    branches: branches.map((b) => ({ repoUrl: repoAddress(b.fullName), ...(b.branch && { branch: b.branch }), ...(b.prUrl && { prUrl: b.prUrl }) })),
  };
}

/** A run as the agents API answers it; an ended one with its result,
 *  duration and the branch (and pull request) its work is on. */
export function cursorRunJson(run: Run, agentId: string, git: readonly GitBranch[]): Record<string, unknown> {
  const over = run.status !== "running" && run.status !== "needs_input";
  return {
    id: cursorRunId(run.number),
    agentId,
    status: cursorRunStatus(run.status),
    createdAt: run.started_at,
    updatedAt: run.ended_at ?? run.started_at,
    ...(over && { durationMs: run.duration_ms, result: run.result, ...(git.length && { git: gitJson(git) }) }),
    ...(run.error && { error: run.error }),
    ...(run.pending_input && { pendingInput: run.pending_input }),
  };
}

/** The session's first run before its prompt is sent (while its box is set
 *  up): Cursor's `CREATING`, or `ERROR` when the setup failed. */
export function pendingRunJson(number: number, agentId: string, session: { status: string; created_at?: unknown; updated_at?: unknown; error_message?: unknown }): Record<string, unknown> {
  const failed = session.status === "failed";
  return {
    id: cursorRunId(number),
    agentId,
    status: failed ? "ERROR" : "CREATING",
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    ...(failed && session.error_message ? { error: session.error_message } : {}),
  };
}

/** Which stream an event is said for: one run's, or the agent's. */
export type CursorStreamTarget = { run: { number: number } | { id: string } } | { agentId: string };

function runIdOf(data: Record<string, unknown>): string | null {
  return typeof data.run_number === "number" ? cursorRunId(data.run_number) : null;
}

/** A stream event (lib/api/stream.ts) as Cursor's stream sends it, or null
 *  for one it has no word for (a run's prompt; on the agent's stream, a
 *  run's result, as Cursor's). Ids are kept: Last-Event-ID resumes. */
export function cursorStreamEvent(event: StreamEvent, target: CursorStreamTarget): StreamEvent | null {
  const { data } = event;
  const say = (name: string, said: Record<string, unknown>): StreamEvent => ({ event: name, id: event.id, data: said });
  const runTarget = "run" in target ? target.run : null;
  const ours = (d: Record<string, unknown>) =>
    !!runTarget && ("number" in runTarget ? d.run_number === runTarget.number : d.run_id === runTarget.id);
  const thisRun = runTarget ? ("number" in runTarget ? cursorRunId(runTarget.number) : runTarget.id) : null;
  switch (event.event) {
    case "status": {
      if (!runTarget) {
        return say("status", { agentId: (target as { agentId: string }).agentId, status: data.state === "idle" ? "IDLE" : "ACTIVE" });
      }
      const creating = say("status", { runId: thisRun, status: "CREATING" });
      if (data.state === "preparing") return creating;
      if (ours(data)) return data.state === "idle" ? null : say("status", { runId: thisRun, status: "RUNNING" });
      // Another run is the newest: one before it (it hasn't begun), or one
      // after (it's over, and its `result` says how).
      const newest = data.run_number;
      const before =
        "number" in runTarget
          ? typeof newest !== "number" || newest < runTarget.number
          : typeof data.run_id !== "string" || Number(data.run_id) < Number(runTarget.id);
      return before ? creating : null;
    }
    case "prompt":
      return null;
    case "assistant":
      return say("assistant", { text: data.text });
    case "thinking":
      return say("thinking", { text: data.text });
    case "tool_call":
      return say("tool_call", {
        callId: data.call_id,
        name: data.name,
        status: data.status,
        ...(data.args !== undefined && { args: data.args }),
        ...(data.result !== undefined && { result: data.result }),
        ...(data.is_error === true && { isError: true }),
      });
    case "needs_input":
      return say("needs_input", { runId: runIdOf(data), pendingInput: data.pending_input });
    case "result": {
      if (!runTarget) return null;
      return say("result", {
        runId: thisRun,
        status: cursorRunStatus(data.status as RunStatus),
        ...(typeof data.text === "string" && { text: data.text }),
        ...(typeof data.duration_ms === "number" && { durationMs: data.duration_ms }),
        ...(typeof data.error === "string" && { error: data.error }),
      });
    }
    default:
      // heartbeat, error, done: the same words.
      return event;
  }
}

/** A page of a list as Cursor's lists answer it: `nextCursor` (the next
 *  page's number), left out on the last page. */
export function cursorPage(items: unknown[], page: { page: number; has_more: boolean }): Record<string, unknown> {
  return { items, ...(page.has_more && { nextCursor: String(page.page + 1) }) };
}

/** Cursor's `limit` and `cursor` as `per_page` and `page`, or the reason
 *  they're refused. */
export function cursorPaging(params: URLSearchParams): { page: number; perPage: number } | string {
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  if (limit !== null && limit !== "" && !/^\d{1,3}$/.test(limit)) return "`limit` is a whole number from 1 to 100.";
  const perPage = limit ? Number(limit) : 20;
  if (perPage < 1 || perPage > 100) return "`limit` is a whole number from 1 to 100.";
  if (cursor !== null && cursor !== "" && !/^[1-9]\d{0,8}$/.test(cursor)) return "`cursor` is the `nextCursor` a list answered with.";
  return { page: cursor ? Number(cursor) : 1, perPage };
}

/** A session's tokens (lib/api/runs.ts sessionUsage) as Cursor counts them. */
function usageJson(usage: Usage): Record<string, number> {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** GET /agents/{id}/usage: in all, and by run (one, with `run`). */
export function cursorUsageJson(total: Usage, runs: readonly Run[]): Record<string, unknown> {
  return {
    totalUsage: usageJson(total),
    runs: runs.map((r) => ({ id: cursorRunId(r.number), usage: usageJson(r.usage) })),
  };
}

/** An artifact's `path`, as Cursor's lists name a file: under `artifacts/`,
 *  with its id, so a download finds it whatever its name. */
export function artifactPath(media: { id: string; name: string; contentType: MediaContentType }): string {
  const stem = media.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "artifact";
  return `artifacts/${media.id}/${stem}.${MEDIA_TYPES[media.contentType]}`;
}

/** The artifact id an `artifacts/…` path names, or null. */
export function artifactIdOf(path: string | null): string | null {
  const match = /^artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/|$)/i.exec(path ?? "");
  return match ? match[1].toLowerCase() : null;
}

/** GET /models' models as Cursor's `items`: an effort is a parameter. */
export function cursorModelItems(models: readonly { id: string; label: string; group: string; efforts: readonly string[]; default_effort: string | null }[]): Record<string, unknown>[] {
  return models.map((m) => ({
    id: m.id,
    displayName: m.label,
    description: m.group,
    aliases: [],
    parameters: m.efforts.length ? [{ id: "effort", values: m.efforts, ...(m.default_effort && { default: m.default_effort }) }] : [],
  }));
}

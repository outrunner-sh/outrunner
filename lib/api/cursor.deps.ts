/**
 * /api/v1/agents: Cursor's Cloud Agents API (lib/api/cursor.ts), answered by
 * the sessions' own operations (lib/api/workspaces.ts, lib/api/stream.deps.ts)
 * with the request said in their words, and their answer in Cursor's.
 */

import { turnState } from "@/lib/api/conversation";
import { DOWNLOAD_SECONDS } from "@/lib/api/artifacts";
import {
  artifactIdOf,
  artifactPath,
  createFromCursor,
  cursorAgentJson,
  cursorAgentStatus,
  cursorPage,
  cursorPaging,
  cursorRunId,
  cursorRunJson,
  cursorStreamEvent,
  cursorUsageJson,
  findRun,
  followUpFromCursor,
  pendingRunJson,
  runRef,
  sessionIdOf,
  type GitBranch,
} from "@/lib/api/cursor";
import { idempotentId } from "@/lib/api/create-request";
import { apiError } from "@/lib/api/errors";
import { jsonBody, type ApiContext } from "@/lib/api/handler";
import { readConversation } from "@/lib/api/live";
import { paginate } from "@/lib/api/pagination";
import { firstRunPending, runsFrom, sessionUsage, type Run } from "@/lib/api/runs";
import { apiStatus, workspaceJson } from "@/lib/api/serialize";
import { streamApi } from "@/lib/api/stream.deps";
import { checkWebhookUrl, messageSent, webhookHooks } from "@/lib/api/webhooks.deps";
import { cancelRunApi, createWorkspace, lifecycleApi, listWorkspaces, ownSession, sendMessageApi, type LifecycleVerb } from "@/lib/api/workspaces";
import { getEnvironment } from "@/lib/db/environments";
import { listSessionMedia, signedMediaUrl } from "@/lib/db/media";
import { getProject, getWorkspace, listWorkspacePullRequests } from "@/lib/db/repositories";
import { isUuid } from "@/lib/ids";
import type { Workspace } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The call, as a session operation reads it: `body` as its JSON, `query`
 *  as its query, `headers` added to its own. Its signal is the call's, so a
 *  stream ends when the client goes. */
function asCall(
  context: ApiContext,
  { body, query, headers }: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> },
): ApiContext {
  const url = new URL(context.request.url);
  if (query) url.search = new URLSearchParams(query).toString();
  const sent = new Headers(context.request.headers);
  // Its own body's length, not the call's.
  sent.delete("content-length");
  for (const [name, value] of Object.entries(headers ?? {})) sent.set(name, value);
  if (body !== undefined) sent.set("content-type", "application/json");
  const request = new Request(url, {
    method: context.request.method,
    headers: sent,
    signal: context.request.signal,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { ...context, request };
}

/** The session an agent's id names: its own id (or `bc-` and it), or the
 *  `agentId` it was created with. */
async function sessionOf(context: ApiContext, agentId: string): Promise<string> {
  const id = sessionIdOf(agentId);
  if (isUuid(id) && (await getWorkspace(id))) return id;
  const keyed = idempotentId(context.owner.id, agentId);
  return (await getWorkspace(keyed)) ? keyed : id;
}

/** Its repositories, and the branch each started from. */
async function reposOf(workspace: Workspace): Promise<{ fullName: string; startingRef: string | null }[]> {
  if (workspace.checkouts?.length) return workspace.checkouts.map((c) => ({ fullName: c.fullName, startingRef: c.baseBranch ?? null }));
  const project = await getProject(workspace.projectId);
  return project ? [{ fullName: project.fullName, startingRef: workspace.baseBranch || null }] : [];
}

/** The branch its work is on in each repository, and its pull request there. */
async function gitOf(workspace: Workspace): Promise<GitBranch[]> {
  const [repos, prs] = await Promise.all([reposOf(workspace), listWorkspacePullRequests([workspace.id])]);
  const projectIds = workspace.checkouts?.length ? workspace.checkouts.map((c) => c.projectId) : [workspace.projectId];
  return repos.map((repo, i) => ({
    fullName: repo.fullName,
    branch: workspace.branch || null,
    prUrl: prs.find((pr) => pr.projectId === projectIds[i])?.url ?? null,
  }));
}

/** The session (its owner's alone), its runs, oldest first, and its turn. */
async function agentRuns(
  context: ApiContext,
  agentId: string,
): Promise<{ workspace: Workspace; runs: Run[]; turn: string | null; total: Run["usage"]; from: string } | Response> {
  const workspace = await ownSession(context, await sessionOf(context, agentId));
  if (workspace instanceof Response) return workspace;
  const conversation = await readConversation(workspace);
  const runs = runsFrom(conversation.entries, conversation.state);
  const turn = conversation.from === "live" ? turnState(conversation.entries.map((e) => e.event), conversation.state) : null;
  return { workspace, runs, turn, total: sessionUsage(conversation.entries, runs).total, from: conversation.from };
}

/** The org's project named `name` (Cursor's named environment, `env.name`)
 *  that the caller can see, or the answer to give. */
export async function projectNamed(context: ApiContext, name: string): Promise<string | Response> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("id")
    .eq("org_id", context.caller.orgId)
    .ilike("name", name.replace(/[\\%_]/g, "\\$&"))
    .is("archived_at", null);
  if (error) throw error;
  // Each read as the caller: getEnvironment answers null for one they can't.
  const seen = (await Promise.all((data ?? []).map((row) => getEnvironment(context.caller.userId, row.id as string)))).filter((e) => e !== null);
  if (seen.length === 0) return apiError(404, `No project named "${name}" in this org that you can see.`);
  if (seen.length > 1) return apiError(409, `More than one project is named "${name}": send its \`environment_id\` instead.`);
  return seen[0].id;
}

/** POST /agents: start a session, answered as Cursor answers: the agent,
 *  and its first run (`run-1`, `CREATING` while its box is set up). */
export async function createAgentApi(context: ApiContext): Promise<Response> {
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const parsed = createFromCursor(raw);
  if (typeof parsed === "string") return apiError(400, parsed);
  if (parsed.envName) {
    const environment = await projectNamed(context, parsed.envName);
    if (environment instanceof Response) return environment;
    parsed.body.environment_id = environment;
  }
  // `agentId` is the key: one header besides it would make the agent
  // unreachable by its agentId later.
  const header = context.request.headers.get("idempotency-key");
  if (parsed.agentId && header !== null && header !== parsed.agentId) return apiError(400, "Send `agentId` or an `Idempotency-Key`, not two different ones.");
  const keyed = parsed.agentId && header === null ? { "idempotency-key": parsed.agentId } : undefined;
  const call = asCall(context, { body: parsed.body, headers: keyed });
  const made = await createWorkspace(call, webhookHooks(call), async (input) => checkWebhookUrl(input.webhookUrl));
  if (!made.ok) return made;
  const session = (await made.json()) as Record<string, unknown>;
  const agentId = String(session.id);
  // Sent again: the agent as it is now, and its first run.
  if (made.headers.has("idempotent-replayed")) {
    const read = await agentRuns(context, agentId);
    if (read instanceof Response) return read;
    const first = read.runs[0];
    return Response.json(
      {
        agent: cursorAgentJson(workspaceJson(read.workspace, context.base), {
          status: cursorAgentStatus(apiStatus(read.workspace.status), read.turn),
          latestRunId: cursorRunId(read.runs.at(-1)?.number ?? 1),
          repos: await reposOf(read.workspace),
        }),
        run: first ? cursorRunJson(first, agentId, await gitOf(read.workspace)) : pendingRunJson(1, agentId, workspaceJson(read.workspace, context.base) as { status: string }),
      },
      { status: 200, headers: { "idempotent-replayed": "true" } },
    );
  }
  const workspace = await getWorkspace(agentId);
  return Response.json(
    {
      agent: cursorAgentJson(session, {
        status: "ACTIVE",
        latestRunId: cursorRunId(1),
        repos: workspace ? await reposOf(workspace) : undefined,
        workOnCurrentBranch: parsed.body.work_on_current_branch === true,
        autoCreatePR: parsed.body.auto_create_pr === true,
      }),
      run: pendingRunJson(1, agentId, { status: "preparing", created_at: session.created_at, updated_at: session.updated_at }),
    },
    { status: 201 },
  );
}

/** GET /agents: the caller's own sessions, newest first, as Cursor lists
 *  agents (`limit`, `cursor`, `prUrl`, `includeArchived`). A listed agent's
 *  status is its session's: ACTIVE while set up, else IDLE (or ARCHIVED);
 *  GET /agents/{id} reads its turn. */
export async function listAgentsApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const paging = cursorPaging(params);
  if (typeof paging === "string") return apiError(400, paging);
  const archived = params.get("includeArchived");
  if (archived !== null && archived !== "true" && archived !== "false") return apiError(400, "`includeArchived` is true or false.");
  const query: Record<string, string> = {
    user_id: "me",
    page: String(paging.page),
    per_page: String(paging.perPage),
    include_archived: archived ?? "false",
  };
  const prUrl = params.get("prUrl");
  if (prUrl !== null) query.pr_url = prUrl;
  const listed = await listWorkspaces(asCall(context, { query }));
  if (!listed.ok) return listed;
  const page = (await listed.json()) as { data: Record<string, unknown>[]; page: number; has_more: boolean };
  const items = page.data.map((session) => cursorAgentJson(session, { status: cursorAgentStatus(String(session.status), null) }));
  return Response.json(cursorPage(items, page));
}

/** GET /agents/{id}: the agent in full, with where its turn is. */
export async function getAgentApi(context: ApiContext, agentId: string): Promise<Response> {
  const read = await agentRuns(context, agentId);
  if (read instanceof Response) return read;
  const { workspace, runs, turn } = read;
  const session = workspaceJson(workspace, context.base);
  return Response.json(
    cursorAgentJson(session, {
      status: cursorAgentStatus(String(session.status), turn),
      latestRunId: cursorRunId(runs.at(-1)?.number ?? 1),
      repos: await reposOf(workspace),
    }),
  );
}

/** POST /agents/{id}/archive, /unarchive, DELETE /agents/{id}: answered,
 *  as Cursor's are, with the agent's id. */
export async function agentLifecycleApi(context: ApiContext, agentId: string, verb: LifecycleVerb): Promise<Response> {
  const id = await sessionOf(context, agentId);
  const done = await lifecycleApi(context, id, verb);
  return done.ok ? Response.json({ id }) : done;
}

/** POST /agents/{id}/runs: a follow-up, sent to the session (reaching the
 *  turn it's on, if it's on one, as `delivery: steer` asks), answered with
 *  the run it starts. */
export async function followUpApi(context: ApiContext, agentId: string): Promise<Response> {
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const parsed = followUpFromCursor(raw);
  if (typeof parsed === "string") return apiError(400, parsed);
  const id = await sessionOf(context, agentId);
  // Its place among the runs is the one after those before it, counted
  // before it's sent: a read after might already hold it, or not yet.
  const before = await agentRuns(context, id);
  if (before instanceof Response) return before;
  const sent = await sendMessageApi(asCall(context, { body: parsed.body }), id, messageSent);
  if (!sent.ok) return sent;
  const { run_id: runId } = (await sent.json()) as { run_id: string | null };
  // The send named its run: its place, as the log has it now (another
  // message sent at the same moment may have come first).
  const after = runId || before.from === "none" ? await agentRuns(context, id) : null;
  const now = after && !(after instanceof Response) ? after.runs : [];
  const logged = runId ? now.find((r) => r.id === runId) : undefined;
  // A session read as nothing before it was woken (paused, its log on its
  // box): counted now, its newest run this one when it says what was sent.
  const sentText = String(parsed.body.content ?? "").trim();
  const woken = before.from === "none" ? (now.at(-1)?.prompt.trim() === sentText ? now.length : now.length + 1) : undefined;
  const number = logged?.number ?? woken ?? before.runs.length + 1;
  const now = new Date().toISOString();
  const run = { id: cursorRunId(number), agentId: id, status: "CREATING", createdAt: now, updatedAt: now };
  if (parsed.steer) return Response.json({ delivery: "steered", runId: run.id, run }, { status: 202 });
  return Response.json({ run }, { status: 201 });
}

/** The run a run's id names, or the answer to give. The first run is
 *  there before its prompt is (`CREATING`, or `ERROR` for a failed setup). */
async function oneRun(
  context: ApiContext,
  agentId: string,
  runId: string,
): Promise<{ workspace: Workspace; run: Run | null; ref: { number: number } | { id: string } } | Response> {
  const ref = runRef(runId);
  if (!ref) return apiError(404, "No run by that id on this agent.");
  const read = await agentRuns(context, agentId);
  if (read instanceof Response) return read;
  const run = findRun(read.runs, ref) ?? null;
  if (!run && !("number" in ref && ref.number === 1 && firstRunPending(read.workspace, read.runs, read.from))) {
    return apiError(404, "No run by that id on this agent.");
  }
  return { workspace: read.workspace, run, ref };
}

/** GET /agents/{id}/runs/{runId}. */
export async function getAgentRunApi(context: ApiContext, agentId: string, runId: string): Promise<Response> {
  const found = await oneRun(context, agentId, runId);
  if (found instanceof Response) return found;
  const { workspace, run } = found;
  if (!run) return Response.json(pendingRunJson(1, workspace.id, workspaceJson(workspace, context.base) as { status: string }));
  return Response.json(cursorRunJson(run, workspace.id, await gitOf(workspace)));
}

/** GET /agents/{id}/runs: its runs, newest first (`limit`, `cursor`). */
export async function listAgentRunsApi(context: ApiContext, agentId: string): Promise<Response> {
  const paging = cursorPaging(new URL(context.request.url).searchParams);
  if (typeof paging === "string") return apiError(400, paging);
  const read = await agentRuns(context, agentId);
  if (read instanceof Response) return read;
  const { workspace, runs } = read;
  const page = paginate([...runs].reverse(), paging);
  const git = await gitOf(workspace);
  const items: Record<string, unknown>[] = page.data.map((run) => cursorRunJson(run, workspace.id, git));
  // A session being set up has its first run already, as Cursor's has.
  if (paging.page === 1 && firstRunPending(workspace, runs, read.from)) items.push(pendingRunJson(1, workspace.id, workspaceJson(workspace, context.base) as { status: string }));
  return Response.json(cursorPage(items, page));
}

/** POST /agents/{id}/runs/{runId}/cancel: stop the run going on. */
export async function cancelAgentRunApi(context: ApiContext, agentId: string, runId: string): Promise<Response> {
  const found = await oneRun(context, agentId, runId);
  if (found instanceof Response) return found;
  if (!found.run) return apiError(409, "That run hasn't begun yet: its session is still being set up.");
  const stopped = await cancelRunApi(context, found.workspace.id, found.run.id);
  return stopped.ok ? Response.json({ id: cursorRunId(found.run.number) }) : stopped;
}

/** GET /agents/{id}/runs/{runId}/stream: the run's events in Cursor's words,
 *  ending with its `result`. A run not begun yet (a session's first, while
 *  it's set up) is waited for. */
export async function streamAgentRunApi(context: ApiContext, agentId: string, runId: string): Promise<Response> {
  const ref = runRef(runId);
  if (!ref) return apiError(404, "No run by that id on this agent.");
  const id = await sessionOf(context, agentId);
  return streamApi(context, id, "number" in ref ? ref : ref.id, (event) => cursorStreamEvent(event, { run: ref }));
}

/** GET /agents/{id}/stream: the agent's events in Cursor's words, across its runs. */
export async function streamAgentApi(context: ApiContext, agentId: string): Promise<Response> {
  const id = await sessionOf(context, agentId);
  return streamApi(context, id, undefined, (event) => cursorStreamEvent(event, { agentId: id }));
}

/** GET /agents/{id}/usage: its tokens, in all and by run (`runId`: one). */
export async function agentUsageApi(context: ApiContext, agentId: string): Promise<Response> {
  const asked = new URL(context.request.url).searchParams.get("runId");
  const ref = asked === null ? null : runRef(asked);
  if (asked !== null && !ref) return apiError(404, "No run by that id on this agent.");
  const read = await agentRuns(context, agentId);
  if (read instanceof Response) return read;
  const one = ref ? findRun(read.runs, ref) : undefined;
  if (ref && !one) return apiError(404, "No run by that id on this agent.");
  return Response.json(cursorUsageJson(read.total, one ? [one] : read.runs));
}

/** The most of a session's files listed. */
const MAX_ARTIFACTS = 500;

/** GET /agents/{id}/artifacts: the screenshots and recordings its agent
 *  uploaded, newest first, by `path`. */
export async function agentArtifactsApi(context: ApiContext, agentId: string): Promise<Response> {
  const workspace = await ownSession(context, await sessionOf(context, agentId));
  if (workspace instanceof Response) return workspace;
  const media = await listSessionMedia(workspace.id, MAX_ARTIFACTS);
  return Response.json({
    items: media.map((m) => ({ path: artifactPath(m), sizeBytes: m.sizeBytes, updatedAt: m.createdAt, name: m.name, contentType: m.contentType })),
  });
}

/** GET /agents/{id}/artifacts/download?path=: a link to one's bytes, for 15 minutes. */
export async function agentArtifactDownloadApi(context: ApiContext, agentId: string): Promise<Response> {
  const path = new URL(context.request.url).searchParams.get("path");
  if (!path) return apiError(400, "`path` is an artifact's, as GET /agents/{id}/artifacts lists it.");
  const id = artifactIdOf(path);
  const workspace = await ownSession(context, await sessionOf(context, agentId));
  if (workspace instanceof Response) return workspace;
  const media = id ? (await listSessionMedia(workspace.id, MAX_ARTIFACTS)).find((m) => m.id === id) : undefined;
  if (!media) return apiError(404, "No artifact at that path on this agent.");
  const url = await signedMediaUrl(media.storagePath, DOWNLOAD_SECONDS);
  return Response.json({ url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() });
}

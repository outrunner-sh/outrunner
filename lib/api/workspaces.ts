/**
 * The public API's sessions (`/api/v1/workspaces`), each operation the
 * app's own: a session is made by createCloudSession, and messaged,
 * stopped, paused, archived and deleted through the same routes the session
 * page calls, as its owner (inside apiRoute). What's here is the API's
 * part: reading the request, who may see what, and answering in its shape.
 *
 * Who sees what: a session is its owner's. An org's admins also see the
 * org's sessions listed (and may filter them by user), as a record; only
 * the owner reads its conversation or acts on it.
 */

import { GET as pullRequestGET } from "@/app/api/workspaces/[id]/pull-request/route";
import { POST as interruptPOST } from "@/app/api/workspaces/[id]/interrupt/route";
import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { POST as messagePOST } from "@/app/api/workspaces/[id]/message/route";
import {
  conversationPage,
  promptSince,
  eventJson,
  lastAssistantText,
  pendingInput,
  turnState,
  type ConversationEntry,
} from "@/lib/api/conversation";
import { firstPrompt, MAX_PROMPT, parseCreate, type CreateInput } from "@/lib/api/create-request";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { readConversation, readLiveConversation } from "@/lib/api/live";
import { pageOf, pageRequest } from "@/lib/api/pagination";
import { isApiSource, isApiStatus, snakeKeys, statusesFor, workspaceJson } from "@/lib/api/serialize";
import { getEnvironment } from "@/lib/db/environments";
import { toWorkspace } from "@/lib/db/mappers";
import { projectLevel } from "@/lib/db/org-access";
import { getProject, getWorkspace } from "@/lib/db/repositories";
import { isUuid } from "@/lib/ids";
import { allows } from "@/lib/orgs/access";
import { isBoxSizeId } from "@/lib/runtime/box-sizes";
import type { Workspace } from "@/lib/runtime/types";
import { createCloudSession, type SessionOutcome } from "@/lib/session/create-cloud-session";
import { holdActingUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The longest `wait` holds a call open. */
export const MAX_WAIT_SECONDS = 600;
const WAIT_EVERY_MS = 3_000;

/** Told when a session made through the API settles (PR 2's webhooks). */
export type CreateHooks = {
  onCreated?: (workspace: Workspace, input: CreateInput) => Promise<void>;
  onSettled?: (outcome: SessionOutcome) => Promise<void>;
};

/** POST /workspaces: start a session. It answers at once, `preparing`; the
 *  box is set up after, and the prompt sent once it's ready. */
export async function createWorkspace(
  context: ApiContext,
  hooks: CreateHooks = {},
  check?: (input: CreateInput) => Promise<Response | null>,
): Promise<Response> {
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const input = parseCreate(raw);
  if (typeof input === "string") return apiError(400, input);
  if (check) {
    const refused = await check(input);
    if (refused) return refused;
  }
  const { owner, caller } = context;

  let projectId = input.projectId;
  if (input.environmentId) {
    const environment = await getEnvironment(owner.id, input.environmentId);
    if (!environment || environment.orgId !== caller.orgId) return apiError(404, "No project by that id that you can see.");
    // A session starts from its repository's own project (the one it's the
    // default of), which is what the new-session screen does too.
    projectId = environment.defaultForProjectId;
    if (!projectId) {
      return apiError(409, "Sessions start from a repository's project. Name one of its repositories with `project_id`.");
    }
  }
  const project = projectId ? await getProject(projectId) : null;
  if (!project || project.orgId !== caller.orgId || !allows(await projectLevel(owner.id, project.id), "read")) {
    return apiError(404, "No repository by that id that you can see in this org.");
  }

  // The kept sign-in stays while the box is set up, after this answer.
  const release = holdActingUser();
  let response: Response;
  try {
    response = await createCloudSession(
      owner,
      project.id,
      {
        branch: input.branch,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        agent: input.agent,
        prompt: input.prompt,
      },
      {
        baseBranch: input.baseBranch,
        firstMessage: firstPrompt(input),
        source: "api",
        boxSize: input.size && isBoxSizeId(input.size) ? input.size : undefined,
        onSettled: async (outcome) => {
          release();
          await hooks.onSettled?.(outcome);
        },
      },
    );
  } catch (error) {
    release();
    throw error;
  }
  if (response.status !== 202) {
    release();
    return errorFromRoute(response, context.base);
  }
  const made = (await response.json()) as { workspace: { id: string } };
  const workspace = await getWorkspace(made.workspace.id);
  if (!workspace) return apiError(500, "The session was made, but couldn't be read back.");
  await hooks.onCreated?.(workspace, input);
  return Response.json({ ...workspaceJson(workspace, context.base), status: "preparing" }, { status: 202 });
}

/** GET /workspaces: the caller's sessions in the org (an admin's, the
 *  org's), newest first, filtered by status, source, user and repository. */
export async function listWorkspaces(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const page = pageRequest(params);
  if (typeof page === "string") return apiError(400, page);
  const { caller } = context;

  const status = params.get("status") || null;
  if (status !== null && !isApiStatus(status)) return apiError(400, "`status` is one of preparing, ready, suspended, archived, failed, deleted and the like.");
  const source = params.get("source") || null;
  if (source !== null && !isApiSource(source)) return apiError(400, "`source` is app, slack, automation or api.");
  let userId = params.get("user_id");
  if (userId === "me") userId = caller.userId;
  if (userId && !isUuid(userId)) return apiError(400, "`user_id` is a user's id, or `me`.");
  if (userId && userId !== caller.userId && caller.role !== "admin") {
    return apiError(403, "Only the org's admins list other members' sessions.");
  }
  const projectId = params.get("project_id");
  if (projectId && !isUuid(projectId)) return apiError(400, "`project_id` is a repository's id.");

  // The service role, with the access checked here: RLS shows each user only
  // their own sessions, and an admin's listing is the org's.
  let query = createSupabaseAdminClient()
    .from("workspaces")
    .select("*", { count: "exact" })
    .eq("org_id", caller.orgId)
    // A Slack thread's research session runs out of sight.
    .eq("background", false);
  const owner = userId ?? (caller.role === "admin" ? null : caller.userId);
  if (owner) query = query.eq("owner_id", owner);
  query = status && isApiStatus(status) ? query.in("status", statusesFor(status)) : query.neq("status", "destroyed");
  if (source && isApiSource(source)) query = query.eq("source", source);
  if (projectId) query = query.eq("project_id", projectId);
  const from = (page.page - 1) * page.perPage;
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, from + page.perPage - 1);
  if (error) throw error;
  return Response.json(pageOf((data ?? []).map((row) => workspaceJson(toWorkspace(row), context.base)), count ?? 0, page));
}

/** The session, if the caller may see it: their own (read as them), or, for
 *  an admin, one of the org's (read as a record). */
async function visible(context: ApiContext, id: string): Promise<{ workspace: Workspace; own: boolean } | null> {
  if (!isUuid(id)) return null;
  const own = await getWorkspace(id);
  if (own && own.orgId === context.caller.orgId) return { workspace: own, own: true };
  if (context.caller.role !== "admin") return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("workspaces")
    .select("*")
    .eq("id", id)
    .eq("org_id", context.caller.orgId)
    .eq("background", false)
    .maybeSingle();
  if (error) throw error;
  return data ? { workspace: toWorkspace(data), own: false } : null;
}

/** The caller's own session, or the answer to give. */
async function ownSession(context: ApiContext, id: string): Promise<Workspace | Response> {
  const found = await visible(context, id);
  if (!found) return apiError(404, "No session by that id that you can see.");
  if (!found.own) return apiError(403, "Only the session's owner can do that.");
  return found.workspace;
}

/** The session's turn, as its live conversation says: null while its box
 *  isn't up (setting up, paused, archived, ended). */
export function turnJson(entries: readonly ConversationEntry[], state: string | null): Record<string, unknown> {
  const events = entries.map((e) => e.event);
  const turn = turnState(events, state);
  return {
    state: turn,
    pending_input: turn === "needs_input" ? pendingInput(events) : null,
    last_message: turn === "working" ? null : lastAssistantText(events),
    last_event_id: entries.length ? String(entries[entries.length - 1].id) : null,
  };
}

/** The session's turn as its box says now; null while its box isn't up. */
export async function turnJsonOf(workspace: Workspace): Promise<Record<string, unknown> | null> {
  const live = await readLiveConversation(workspace);
  return live ? turnJson(live.entries, live.state) : null;
}

/** GET /workspaces/{id}: the session, and where its turn is. */
export async function getWorkspaceApi(context: ApiContext, id: string): Promise<Response> {
  const found = await visible(context, id);
  if (!found) return apiError(404, "No session by that id that you can see.");
  const turn = found.own ? await turnJsonOf(found.workspace) : null;
  return Response.json({ ...workspaceJson(found.workspace, context.base), turn });
}

/** GET /workspaces/{id}/conversation: its events, newest last, a page at a
 *  time going back (`before_event`). */
export async function readConversationApi(context: ApiContext, id: string): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const before = params.get("before_event");
  if (before !== null && !/^\d{1,15}$/.test(before)) return apiError(400, "`before_event` is an event's id.");
  const perPageText = params.get("per_page") ?? "50";
  const perPage = /^\d{1,3}$/.test(perPageText) ? Number(perPageText) : 0;
  if (perPage < 1 || perPage > 100) return apiError(400, "`per_page` must be a whole number from 1 to 100.");
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;

  const conversation = await readConversation(workspace);
  const page = conversationPage(conversation.entries, { before: before === null ? undefined : Number(before), limit: perPage });
  return Response.json({
    data: page.events.map(eventJson),
    per_page: perPage,
    has_more: page.hasMore,
    next_before_event: page.nextBefore === null ? null : String(page.nextBefore),
    from: conversation.from,
    turn: conversation.from === "live" ? turnJson(conversation.entries, conversation.state) : null,
  });
}

/** Wake a paused or archived session, as opening it in the app does. */
async function wake(context: ApiContext, workspace: Workspace): Promise<Response | null> {
  if (workspace.status !== "suspended" && workspace.status !== "archived") return null;
  const action = workspace.status === "suspended" ? "resume" : "restore";
  const woken = await lifecyclePOST(
    appRequest(context.base, `/api/workspaces/${workspace.id}/lifecycle`, { body: { action } }),
    routeParams({ id: workspace.id }),
  );
  return woken.ok ? null : errorFromRoute(woken, context.base);
}

/** POST /workspaces/{id}/messages: send the session a message, waking it
 *  first if it was paused or archived. */
export async function sendMessageApi(
  context: ApiContext,
  id: string,
  onSent?: (workspace: Workspace) => Promise<void>,
): Promise<Response> {
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) return apiError(400, "Say something (`content`).");
  if (content.length > MAX_PROMPT) return apiError(400, "The message is too long.");
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const refused = await wake(context, workspace);
  if (refused) return refused;
  // Where the log stands before the send, for `wait?after_event=`: its turn
  // is over only once this message is in the log after it.
  const before = await readLiveConversation((await getWorkspace(id)) ?? workspace).catch(() => null);
  const afterEvent = before?.entries.length ? String(before.entries[before.entries.length - 1].id) : before ? "0" : null;
  const sent = await messagePOST(
    appRequest(context.base, `/api/workspaces/${id}/message`, { body: { content } }),
    routeParams({ id }),
  );
  if (!sent.ok) return errorFromRoute(sent, context.base);
  await onSent?.(workspace);
  return Response.json({ result: "sent", workspace_id: id, after_event: afterEvent }, { status: 202 });
}

/** POST /workspaces/{id}/interrupt: stop the turn it's running. */
export async function interruptApi(context: ApiContext, id: string): Promise<Response> {
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const stopped = await interruptPOST(appRequest(context.base, `/api/workspaces/${id}/interrupt`), routeParams({ id }));
  if (!stopped.ok) return errorFromRoute(stopped, context.base);
  return Response.json({ result: "interrupted", workspace_id: id });
}

export type LifecycleVerb = "suspend" | "resume" | "archive" | "delete";

/** Pause, wake, archive or delete the session, through the session page's
 *  lifecycle route; answers with the session as it is after. */
export async function lifecycleApi(context: ApiContext, id: string, verb: LifecycleVerb): Promise<Response> {
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const action =
    verb === "delete" ? "destroy" : verb === "resume" && workspace.status === "archived" ? "restore" : verb;
  const done = await lifecyclePOST(
    appRequest(context.base, `/api/workspaces/${id}/lifecycle`, { body: { action } }),
    routeParams({ id }),
  );
  if (!done.ok) return errorFromRoute(done, context.base);
  if (verb === "delete") return new Response(null, { status: 204 });
  const now = (await getWorkspace(id)) ?? workspace;
  return Response.json(workspaceJson(now, context.base));
}

/** GET /workspaces/{id}/pull-requests: the pull request in each of its
 *  repositories, and where each stands on GitHub. */
export async function pullRequestsApi(context: ApiContext, id: string): Promise<Response> {
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const repos = workspace.checkouts?.map((c) => ({ projectId: c.projectId, fullName: c.fullName })) ?? [
    { projectId: workspace.projectId, fullName: (await getProject(workspace.projectId))?.fullName ?? null },
  ];
  const data = [];
  for (const repo of repos) {
    const path = `/api/workspaces/${id}/pull-request${workspace.checkouts ? `?projectId=${repo.projectId}` : ""}`;
    const answer = await pullRequestGET(appRequest(context.base, path, { method: "GET" }), routeParams({ id }));
    if (!answer.ok) return errorFromRoute(answer, context.base);
    const { pullRequest, status } = (await answer.json()) as { pullRequest: unknown; status: unknown };
    data.push({ project_id: repo.projectId, full_name: repo.fullName, pull_request: snakeKeys(pullRequest), status: snakeKeys(status) });
  }
  return Response.json({ data });
}

/**
 * GET /workspaces/{id}/wait: hold the call until the session's turn is over
 * (idle), it needs input, its setup ends, or `timeout` seconds pass (600 at
 * most). Answers with the session and its turn either way: `timed_out`
 * says which.
 */
export async function waitApi(context: ApiContext, id: string): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const timeoutText = params.get("timeout") ?? String(MAX_WAIT_SECONDS);
  const seconds = /^\d{1,4}$/.test(timeoutText) ? Number(timeoutText) : -1;
  if (seconds < 0 || seconds > MAX_WAIT_SECONDS) {
    return apiError(400, `\`timeout\` is a number of seconds from 0 to ${MAX_WAIT_SECONDS}.`);
  }
  const after = params.get("after_event");
  if (after !== null && !/^\d{1,15}$/.test(after)) return apiError(400, "`after_event` is an event's id.");
  const afterEvent = after === null ? null : Number(after);
  const first = await ownSession(context, id);
  if (first instanceof Response) return first;

  const until = Date.now() + seconds * 1000;
  let workspace = first;
  for (;;) {
    const settled = await waitOutcome(workspace, afterEvent);
    if (settled) return Response.json({ ...workspaceJson(workspace, context.base), turn: settled.turn, timed_out: false });
    if (Date.now() + WAIT_EVERY_MS > until || context.request.signal.aborted) {
      return Response.json({ ...workspaceJson(workspace, context.base), turn: await turnJsonOf(workspace), timed_out: true });
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_EVERY_MS));
    workspace = (await getWorkspace(id)) ?? workspace;
  }
}

/**
 * Whether there's nothing more to wait for, and the turn as it is then. A
 * turn that's idle counts only once its prompt is in the log: one after
 * `afterEvent` when it's given (what a send answered with), else any, for a
 * session the API started (whose first prompt follows its ready).
 */
async function waitOutcome(
  workspace: Workspace,
  afterEvent: number | null,
): Promise<{ turn: Record<string, unknown> | null } | null> {
  switch (workspace.status) {
    case "creating":
    case "provisioning":
    case "resuming":
    case "restoring":
    case "suspending":
    case "archiving":
    case "destroying":
      return null;
    case "ready":
    case "idle": {
      const live = await readLiveConversation(workspace);
      // A box that didn't answer this time may on the next.
      if (!live) return null;
      const turn = turnJson(live.entries, live.state);
      if (turn.state === "working") return null;
      const prompted = afterEvent !== null || workspace.source === "api";
      if (prompted && turn.state === "idle" && !promptSince(live.entries, afterEvent)) return null;
      return { turn };
    }
    default:
      // Failed, paused, archived or deleted: no turn will end by waiting.
      return { turn: null };
  }
}

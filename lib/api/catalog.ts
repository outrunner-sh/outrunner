/**
 * What the public API lists besides sessions: who the key acts as, the
 * org's projects and repositories the caller may start sessions on, and its
 * triage. Each read follows the org's Roles & access for the key's maker,
 * as the app's own pages do.
 */

import { cursorPage, cursorPaging, repoAddress } from "@/lib/api/cursor";
import { cursorEnvironmentJson } from "@/lib/api/cursor-environments";
import { repoFullName } from "@/lib/api/repo-ref";
import { apiError } from "@/lib/api/errors";
import { jsonBody, type ApiContext } from "@/lib/api/handler";
import { paginate, pageRequest } from "@/lib/api/pagination";
import { environmentJson, projectJson, triageItemJson } from "@/lib/api/serialize";
import { listOrgApiKeys, listPersonalApiKeys } from "@/lib/db/api-keys";
import { getEnvironment, type Environment } from "@/lib/db/environments";
import { getOrg } from "@/lib/db/orgs";
import { listProjects } from "@/lib/db/repositories";
import {
  captureWorkItem,
  getWorkItem,
  listWorkItems,
  resolveProject,
  triageActor,
  WorkItemChangeError,
} from "@/lib/db/work-items";
import { isUuid } from "@/lib/ids";
import { allows } from "@/lib/orgs/access";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { permissionsFor, type TriageActor } from "@/lib/triage/access";
import { parseNewWorkItem, WORK_ITEM_STATUSES, type WorkItemStatus } from "@/lib/triage/work-items";

/** GET /me: who the key acts as, where, and with what. */
export async function meApi(context: ApiContext): Promise<Response> {
  const { owner, caller } = context;
  const [org, keys] = await Promise.all([
    getOrg(caller.orgId),
    caller.keyId ? Promise.all([listPersonalApiKeys(owner.id), listOrgApiKeys(caller.orgId)]).then((lists) => lists.flat()) : [],
  ]);
  const key = keys.find((k) => k.id === caller.keyId);
  const [first, ...rest] = owner.name.trim().split(/\s+/);
  return Response.json({
    user: { id: owner.id, login: owner.githubLogin || null, name: owner.name, email: owner.email },
    org: org ? { id: org.id, name: org.name, role: caller.role } : null,
    credential: { kind: caller.kind, id: caller.keyId ?? caller.cliTokenId },
    // As Cursor's GET /v1/me says it, for scripts moved from it.
    ...(key && { apiKeyName: key.name, createdAt: key.createdAt }),
    userId: owner.id,
    userEmail: owner.email,
    userFirstName: first || null,
    userLastName: rest.join(" ") || null,
  });
}

async function actorOf(context: ApiContext): Promise<TriageActor | Response> {
  const actor = await triageActor(context.caller.userId, context.caller.orgId);
  return actor ?? apiError(403, "You aren't a member of that org.");
}

/** GET /projects: the org's repositories the caller may start sessions on. */
export async function listProjectsApi(context: ApiContext): Promise<Response> {
  const page = pageRequest(new URL(context.request.url).searchParams);
  if (typeof page === "string") return apiError(400, page);
  const actor = await actorOf(context);
  if (actor instanceof Response) return actor;
  const projects = (await listProjects(context.caller.orgId)).filter((p) => allows(actor.levels.get(p.id), "read"));
  return Response.json(paginate(projects.map(projectJson), page));
}

/** GET /repositories: the org's repositories the caller may start sessions
 *  on, as Cursor's API lists them: each one's address. */
export async function listRepositoriesApi(context: ApiContext): Promise<Response> {
  const actor = await actorOf(context);
  if (actor instanceof Response) return actor;
  const projects = (await listProjects(context.caller.orgId)).filter((p) => allows(actor.levels.get(p.id), "read"));
  return Response.json({ items: projects.map((p) => ({ url: `https://${repoAddress(p.fullName)}` })) });
}

/** GET /environments: the org's projects (the app's, of one or several
 *  repositories) the caller may read. */
export async function listEnvironmentsApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  // Cursor's `limit` and `cursor` are taken for `per_page` and `page`.
  const cursorPaged = params.has("limit") || params.has("cursor");
  const paging = cursorPaged ? cursorPaging(params) : pageRequest(params);
  if (typeof paging === "string") return apiError(400, paging);
  const owner = params.get("owner");
  if (owner !== null && owner !== "personal" && owner !== "team") return apiError(400, "`owner` is personal or team.");
  const named = params.get("named");
  if (named !== null && named !== "true" && named !== "false") return apiError(400, "`named` is true or false.");
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("id")
    .eq("org_id", context.caller.orgId)
    .is("archived_at", null)
    .order("name", { ascending: true });
  if (error) throw error;
  // Each read as the caller: getEnvironment answers null for one they can't.
  const environments: (Environment | null)[] = await Promise.all((data ?? []).map((row) => getEnvironment(context.caller.userId, row.id)));
  // Cursor's filters: a name's part, its repositories (each to match), and
  // whether it's one someone made (`named`) rather than a repository's own.
  const query = params.get("query")?.toLowerCase();
  const repos = params.getAll("repo").map((r) => (repoFullName(r) ?? r).toLowerCase());
  const kept = environments.flatMap((e): Environment[] => {
    if (!e) return [];
    // Every org is a team's (Cursor's `owner: team`): none is personal.
    if (owner === "personal") return [];
    if (query && !e.name.toLowerCase().includes(query)) return [];
    if (named !== null && (named === "true") === Boolean(e.defaultForProjectId)) return [];
    if (repos.some((r) => !e.repos.some((repo) => repo.fullName.toLowerCase() === r))) return [];
    return [e];
  });
  const page = paginate(kept, paging);
  return Response.json({
    ...page,
    data: page.data.map(environmentJson),
    // As Cursor's list answers: each in its words, and the next page's cursor.
    ...cursorPage(page.data.map((e) => cursorEnvironmentJson(e, false)), page),
  });
}

/** GET /triage/items: the org's work items the caller may see, filtered by
 *  status and repository. */
export async function listTriageApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const page = pageRequest(params);
  if (typeof page === "string") return apiError(400, page);
  const status = params.get("status");
  if (status && !(WORK_ITEM_STATUSES as readonly string[]).includes(status)) {
    return apiError(400, `\`status\` is one of ${WORK_ITEM_STATUSES.join(", ")}.`);
  }
  const projectId = params.get("project_id");
  if (projectId && projectId !== "none" && !isUuid(projectId)) return apiError(400, "`project_id` is a repository's id, or `none` for Unsorted.");
  const actor = await actorOf(context);
  if (actor instanceof Response) return actor;
  const items = (await listWorkItems(actor)).filter(
    (item) =>
      (!status || item.status === (status as WorkItemStatus)) &&
      (!projectId || item.projectId === (projectId === "none" ? null : projectId)),
  );
  return Response.json(
    paginate(
      items.map((item) => triageItemJson({ ...item, can: permissionsFor(actor, item) }, context.base)),
      page,
    ),
  );
}

/** GET /triage/items/{id}. */
export async function getTriageApi(context: ApiContext, id: string): Promise<Response> {
  const actor = await actorOf(context);
  if (actor instanceof Response) return actor;
  const item = isUuid(id) ? await getWorkItem(actor, id) : null;
  if (!item) return apiError(404, "No work item by that id that you can see.");
  return Response.json(triageItemJson({ ...item, can: permissionsFor(actor, item) }, context.base));
}

/** POST /triage/items: file a work item, as `POST /api/triage/items` does
 *  for the CLI (a `source_ref` the org has makes it a note on that one). */
export async function createTriageApi(context: ApiContext): Promise<Response> {
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const actor = await actorOf(context);
  if (actor instanceof Response) return actor;
  // `project_id` is the API's name for it; `project` (owner/name) the CLI's.
  const input = parseNewWorkItem({ ...raw, project: raw.project_id ?? raw.project }, ["api"]);
  if (typeof input === "string") return apiError(400, input);
  let projectId: string | null = null;
  if (input.project) {
    projectId = await resolveProject(actor, input.project);
    if (!projectId) return apiError(404, `No repository ${input.project} that you can see. Leave it out to file the item as Unsorted.`);
  }
  try {
    const result = await captureWorkItem(actor, { ...input, projectId });
    return Response.json(
      { ...triageItemJson({ ...result.item, can: permissionsFor(actor, result.item) }, context.base), created: result.kind === "created" },
      { status: result.kind === "created" ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof WorkItemChangeError) return apiError(error.status, error.message);
    throw error;
  }
}

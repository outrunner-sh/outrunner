/**
 * Cursor's Projects API (lib/api/cursor-projects.ts), answered by Missions:
 * POST /api/v1/projects, GET /api/v1/missions (Cursor's GET /v1/projects:
 * /api/v1/projects lists repositories here), and /api/v1/projects/{id}/…,
 * each through the Missions' own code (createCloudSession with `kind:
 * "mission"`, PATCH /api/missions/{id}, archiveMission), as the caller.
 *
 * A caller sees their own Missions in the key's org, as the sidebar shows
 * them; an org's admins don't list others'.
 */

import { PATCH as missionPATCH } from "@/app/api/missions/[id]/route";
import { checkAttachments } from "@/lib/api/attachments";
import { cursorAgentJson, cursorAgentStatus, cursorPage, cursorPaging, pendingRunJson } from "@/lib/api/cursor";
import { projectNamed } from "@/lib/api/cursor.deps";
import {
  cursorProjectJson,
  includeArchived,
  missionIdOf,
  projectFromCursor,
  projectPatchFromCursor,
  projectTitle,
  type ProjectCreate,
} from "@/lib/api/cursor-projects";
import { idempotencyKey, idempotentId } from "@/lib/api/create-request";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { imagesToAttachments } from "@/lib/api/images.deps";
import { pageOf, paginate } from "@/lib/api/pagination";
import { workspaceJson, workspaceUrl } from "@/lib/api/serialize";
import { lifecycleApi } from "@/lib/api/workspaces";
import { defaultEnvironmentId, getEnvironment } from "@/lib/db/environments";
import { toWorkspace } from "@/lib/db/mappers";
import { projectLevel } from "@/lib/db/org-access";
import { getProject, getProjectByFullName, getWorkspace } from "@/lib/db/repositories";
import { isUuid } from "@/lib/ids";
import { archiveMission } from "@/lib/missions/archive";
import { missionArchiveDeps } from "@/lib/missions/archive.deps";
import { MISSION_ICONS, missionIcon } from "@/lib/missions/icons";
import { runnersOf } from "@/lib/missions/store";
import { missionsFor, ownsMission, setMissionProfile } from "@/lib/missions/view.deps";
import { allows } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";
import { createCloudSession } from "@/lib/session/create-cloud-session";
import { holdActingUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const ICONS = MISSION_ICONS.map((i) => i.key);

/** Sessions gone for good: no project is answered for one. */
const GONE = ["destroying", "destroyed"];

function db() {
  return createSupabaseAdminClient();
}

/** The icons the Missions `ids` were given, by Mission. */
async function pickedIcons(ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db().from("mission_profiles").select("mission_id, icon").in("mission_id", ids);
  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.mission_id, p.icon]));
}

function projectJson(context: ApiContext, mission: Workspace, picked: string | null): Record<string, unknown> {
  return cursorProjectJson(mission, { icon: missionIcon(mission.id, picked).key, url: workspaceUrl(context.base, mission.id) });
}

/** The caller's own Mission (in the key's org) a project's id names: its
 *  id (or `bc-` and it), or the `projectId` it was created with; or the
 *  answer to give. */
async function missionOf(context: ApiContext, ref: string): Promise<Workspace | Response> {
  const own = async (id: string) => {
    if (!isUuid(id)) return null;
    const mission = await ownsMission(context.owner.id, id);
    return mission && mission.orgId === context.caller.orgId && !GONE.includes(mission.status) ? mission : null;
  };
  const found = (await own(missionIdOf(ref))) ?? (await own(idempotentId(context.owner.id, ref)));
  return found ?? apiError(404, "No project by that id that you can see.");
}

/** The project of Outrunner's (an `environments` row) a create names, and
 *  the repository it starts from; or the answer to give. */
async function placeOf(context: ApiContext, create: ProjectCreate): Promise<{ environmentId: string; projectId: string } | Response> {
  const { owner, caller } = context;
  const { place } = create;
  let environmentId: string | null;
  if ("envName" in place) {
    const named = await projectNamed(context, place.envName);
    if (named instanceof Response) return named;
    environmentId = named;
  } else if ("environmentId" in place) {
    environmentId = place.environmentId;
  } else {
    // A repository: its own project, as the app's Mission screen starts one.
    const repo = "projectId" in place ? await getProject(place.projectId) : await getProjectByFullName(caller.orgId, place.repoFullName);
    if (!repo || repo.orgId !== caller.orgId) {
      return apiError(404, "No repository at that address in this org that you can see. Add it to Outrunner first.");
    }
    environmentId = await defaultEnvironmentId(owner.id, repo.id);
  }
  const environment = environmentId ? await getEnvironment(owner.id, environmentId) : null;
  if (!environment || environment.orgId !== caller.orgId) return apiError(404, "No project by that id that you can see.");
  const projectId = environment.defaultForProjectId ?? environment.repos[0]?.projectId;
  const project = projectId ? await getProject(projectId) : null;
  if (!project || project.orgId !== caller.orgId || !allows(await projectLevel(owner.id, project.id), "read")) {
    return apiError(404, "That project isn't one you can start a Mission in.");
  }
  return { environmentId: environment.id, projectId: project.id };
}

/** The project made, and its first run (`run-1`: `CREATING` while its box
 *  is set up, `ERROR` if that failed). */
function madeJson(context: ApiContext, mission: Workspace, picked: string | null): Record<string, unknown> {
  const session = workspaceJson(mission, context.base) as { status: string; created_at?: unknown; updated_at?: unknown; error_message?: unknown };
  const failed = session.status === "failed";
  return {
    project: projectJson(context, mission, picked),
    run: pendingRunJson(1, mission.id, failed ? session : { status: "preparing", created_at: session.created_at, updated_at: session.updated_at }),
  };
}

/**
 * POST /projects: start a Mission, as the app's Mission screen does (POST
 * /api/missions), with its prompt sent once its box is ready, as POST
 * /workspaces sends a session's. Answered as Cursor answers: the project,
 * and its coordinator's first run. Sent again with its `projectId` (or
 * `Idempotency-Key`), the Mission the first made, `idempotent-replayed`.
 */
export async function createProjectApi(context: ApiContext): Promise<Response> {
  const header = idempotencyKey(context.request.headers);
  if (header && typeof header === "object") return apiError(400, header.refused);
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const create = projectFromCursor(raw, ICONS);
  if (typeof create === "string") return apiError(400, create);
  const { owner } = context;

  const key = header ?? create.key;
  const askedId = key ? idempotentId(owner.id, key) : undefined;
  const replayed = askedId ? await getWorkspace(askedId) : null;
  if (replayed && replayed.ownerId === owner.id) {
    if (replayed.kind !== "mission") return apiError(409, "That `projectId` started an agent, not a project: send another.");
    const picked = (await pickedIcons([replayed.id])).get(replayed.id) ?? null;
    return Response.json(madeJson(context, replayed, picked), { status: 200, headers: { "idempotent-replayed": "true" } });
  }

  const place = await placeOf(context, create);
  if (place instanceof Response) return place;
  const unknownFile = await checkAttachments(create.attachmentIds);
  if (unknownFile) return unknownFile;
  const imageIds = await imagesToAttachments(context, create.images);
  if (imageIds instanceof Response) return imageIds;
  const title = projectTitle(create);

  // The kept sign-in stays while the box is set up, after this answer.
  const release = holdActingUser();
  let response: Response;
  try {
    response = await createCloudSession(
      owner,
      place.projectId,
      {
        branch: create.branch,
        provider: create.provider,
        model: create.model,
        effort: create.effort,
        agent: create.agent,
        prompt: create.prompt,
        ...(askedId && { id: askedId }),
      },
      {
        kind: "mission",
        environmentId: place.environmentId,
        baseBranch: create.startingRef,
        ...(title && { title }),
        ...(create.prompt && { firstMessage: create.prompt, firstAttachmentIds: [...create.attachmentIds, ...imageIds] }),
        source: "api",
        boxSize: create.size,
        onSettled: async () => release(),
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
  const mission = await getWorkspace(made.workspace.id);
  if (!mission) return apiError(500, "The project was made, but couldn't be read back.");
  if (create.appearance.icon) await setMissionProfile(mission.id, { icon: create.appearance.icon });
  return Response.json(madeJson(context, mission, create.appearance.icon ?? null), { status: 201 });
}

/** GET /missions (Cursor's GET /v1/projects): the caller's own Missions in
 *  the org, newest first (`limit`, `cursor`, `includeArchived`, true unless
 *  asked otherwise). */
export async function listCursorProjectsApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const paging = cursorPaging(params);
  if (typeof paging === "string") return apiError(400, paging);
  const archived = includeArchived(params);
  if (typeof archived === "string") return apiError(400, archived);
  let query = db()
    .from("workspaces")
    .select("*", { count: "exact" })
    .eq("owner_id", context.owner.id)
    .eq("org_id", context.caller.orgId)
    .eq("kind", "mission")
    .not("status", "in", `(${GONE.join(",")})`);
  if (!archived) query = query.not("status", "in", "(archiving,archived)");
  const from = (paging.page - 1) * paging.perPage;
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, from + paging.perPage - 1);
  if (error) throw error;
  const missions: Workspace[] = (data ?? []).map(toWorkspace);
  const icons = await pickedIcons(missions.map((m) => m.id));
  const items = missions.map((m) => projectJson(context, m, icons.get(m.id) ?? null));
  return Response.json(cursorPage(items, pageOf(items, count ?? 0, paging)));
}

/** GET /projects/{id}. */
export async function getCursorProjectApi(context: ApiContext, ref: string): Promise<Response> {
  const mission = await missionOf(context, ref);
  if (mission instanceof Response) return mission;
  return Response.json(projectJson(context, mission, (await pickedIcons([mission.id])).get(mission.id) ?? null));
}

/** PATCH /projects/{id}: rename it, or give it another icon, through the
 *  Mission's own rename (PATCH /api/missions/{id}). Answered 204. */
export async function patchCursorProjectApi(context: ApiContext, ref: string): Promise<Response> {
  const raw = await jsonBody(context.request);
  if (raw instanceof Response) return raw;
  const patch = projectPatchFromCursor(raw, ICONS);
  if (typeof patch === "string") return apiError(400, patch);
  const mission = await missionOf(context, ref);
  if (mission instanceof Response) return mission;
  if (patch.title !== undefined || patch.icon !== undefined) {
    const done = await missionPATCH(
      appRequest(context.base, `/api/missions/${mission.id}`, { method: "PATCH", body: patch }),
      routeParams({ id: mission.id }),
    );
    if (!done.ok) return errorFromRoute(done, context.base);
  }
  return new Response(null, { status: 204 });
}

/** Its repositories, and the branch each started from. */
async function reposOf(session: Workspace): Promise<{ fullName: string; startingRef: string | null }[]> {
  if (session.checkouts?.length) return session.checkouts.map((c) => ({ fullName: c.fullName, startingRef: c.baseBranch ?? null }));
  const project = await getProject(session.projectId);
  return project ? [{ fullName: project.fullName, startingRef: session.baseBranch || null }] : [];
}

/**
 * GET /projects/{id}/agents: its coordinator (the Mission's own session)
 * first, then its Ships, newest first, as GET /agents/{id} answers each
 * (`limit`, `cursor`). Each is ACTIVE while it's set up or at work, as the
 * Ships pane reads it; IDLE otherwise, or ARCHIVED.
 */
export async function projectAgentsApi(context: ApiContext, ref: string): Promise<Response> {
  const paging = cursorPaging(new URL(context.request.url).searchParams);
  if (typeof paging === "string") return apiError(400, paging);
  const mission = await missionOf(context, ref);
  if (mission instanceof Response) return mission;
  const [ships, [view]] = await Promise.all([runnersOf(mission.id), missionsFor(context.owner.id, context.caller.orgId, mission.id)]);
  const working = new Set([
    ...(view?.standing?.standing === "working" ? [mission.id] : []),
    ...(view?.runners ?? []).filter((r) => r.state === "working" || r.state === "setting_up").map((r) => r.id),
  ]);
  const page = paginate([mission, ...ships.filter((s) => s.ownerId === context.owner.id && !GONE.includes(s.status))], paging);
  const items = await Promise.all(
    page.data.map(async (session) => {
      const json = workspaceJson(session, context.base);
      return cursorAgentJson(json, {
        status: cursorAgentStatus(String(json.status), working.has(session.id) ? "working" : null),
        repos: await reposOf(session),
      });
    }),
  );
  return Response.json(cursorPage(items, page));
}

/**
 * POST /projects/{id}/archive: archive the Mission with its Ships
 * (archiveMission, as the Mission's Archive does), answered `{ id }`. One
 * call archives for up to two minutes and stops there, so a Mission of many
 * Ships may take more than one: until then it answers 202 with `pending`,
 * and calling again goes on where it stopped. One that can't be archived
 * yet (a Ship setting up, say) is 409, saying which.
 */
export async function archiveCursorProjectApi(context: ApiContext, ref: string): Promise<Response> {
  const mission = await missionOf(context, ref);
  if (mission instanceof Response) return mission;
  const result = await archiveMission(mission, missionArchiveDeps());
  if (result.archived) return Response.json({ id: mission.id, ...(result.note && { note: result.note }) });
  if (result.more) return Response.json({ id: mission.id, pending: true, message: result.why }, { status: 202 });
  return apiError(409, result.why);
}

/** POST /projects/{id}/unarchive: restore the Mission's own session, as
 *  opening it would. Its Ships stay archived: each comes back as it's
 *  messaged (by the Mission, or POST /agents/{id}/runs). */
export async function unarchiveCursorProjectApi(context: ApiContext, ref: string): Promise<Response> {
  const mission = await missionOf(context, ref);
  if (mission instanceof Response) return mission;
  if (mission.status === "archiving") return apiError(409, "It's still being archived: unarchive it once that's done.");
  if (mission.status !== "archived") return Response.json({ id: mission.id });
  const done = await lifecycleApi(context, mission.id, "resume");
  return done.ok ? Response.json({ id: mission.id }) : done;
}

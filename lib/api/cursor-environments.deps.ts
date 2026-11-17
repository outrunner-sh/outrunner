/**
 * Cursor's environments and secrets (lib/api/cursor-environments.ts), on
 * Outrunner's projects and secrets. A project's changes go through the
 * settings page's own routes (app/api/environments/[id]), as the rest of
 * the API's do (lib/api/environments.ts); what has no route of its own
 * (making and deleting a project, the org's and a person's secrets) is
 * here, held to the same rules: changing what runs on members' boxes is an
 * org key's (boxSetupRefused).
 */

import { PATCH as environmentPATCH } from "@/app/api/environments/[id]/route";
import { POST as warmPOST } from "@/app/api/environments/[id]/warm/route";
import { DELETE as reposDELETE, POST as reposPOST } from "@/app/api/environments/[id]/repos/route";
import { PATCH as secretsPATCH } from "@/app/api/environments/[id]/secrets/route";
import { describeAudit } from "@/lib/audit/actions";
import { PROJECT_RESOURCE, recordProjectChange } from "@/lib/audit/project-history";
import { boxSetupRefused } from "@/lib/api/auth";
import { cursorPage, cursorPaging } from "@/lib/api/cursor";
import {
  cursorBuildJson,
  cursorEnvironmentJson,
  historyItemJson,
  hooksFromEnvironmentJson,
  projectSecretJson,
  repoNamesOf,
  SECRET_NAME,
  secretPutOf,
  secretVersionJson,
} from "@/lib/api/cursor-environments";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { environmentDetailJson } from "@/lib/api/serialize";
import { listResourceAuditEvents } from "@/lib/db/audit";
import { archiveEnvironment, createEnvironment, EnvironmentAccessError, getEnvironment, type Environment } from "@/lib/db/environments";
import { getOrg } from "@/lib/db/orgs";
import { getProjectByFullName } from "@/lib/db/repositories";
import { deleteScopedSecret, listScopedSecrets, putScopedSecret, type SecretScope } from "@/lib/db/scoped-secrets";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { settableEnv } from "@/lib/imports/settable-env";
import { isUuid } from "@/lib/ids";

const notFound = () => apiError(404, "No project by that id that you can see.");

async function projectOf(context: ApiContext, id: string): Promise<Environment | Response> {
  if (!isUuid(id)) return notFound();
  const environment = await getEnvironment(context.caller.userId, id);
  return environment && environment.orgId === context.caller.orgId ? environment : notFound();
}

async function personalOrg(context: ApiContext): Promise<boolean> {
  return (await getOrg(context.caller.orgId))?.personal ?? false;
}

/** A project, said both ways: Outrunner's fields and Cursor's. */
export async function bothWays(context: ApiContext, environment: Environment, full = true): Promise<Record<string, unknown>> {
  return { ...environmentDetailJson(environment), ...cursorEnvironmentJson(environment, await personalOrg(context), full) };
}

/** The repositories Cursor's `repos` name, as the org's projects' ids, or
 *  the answer to give. */
async function repoIds(context: ApiContext, value: unknown): Promise<string[] | Response> {
  const names = repoNamesOf(value);
  if (typeof names === "string") return apiError(400, names);
  const ids: string[] = [];
  for (const name of names) {
    const project = await getProjectByFullName(context.caller.orgId, name);
    if (!project) return apiError(404, `${name} isn't connected to this org, or you can't see it. Add it to Outrunner first.`);
    ids.push(project.id);
  }
  return ids;
}

function ruleError(error: unknown): Response | null {
  if (error instanceof EnvironmentRuleError) return apiError(400, error.message);
  if (error instanceof EnvironmentAccessError) return apiError(403, error.message);
  return null;
}

/** POST /environments: make a project of some of the org's repositories,
 *  with Cursor's `environmentJson` as its hooks (an org key's to set). Its
 *  `name` and `repos` (`[{ url }]`), or Outrunner's `project_ids`. */
export async function createEnvironmentApi(context: ApiContext): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  if (typeof body.name !== "string" || !body.name.trim()) return apiError(400, "Name the project (`name`).");
  if (body.owner !== undefined && body.owner !== "personal" && body.owner !== "team") return apiError(400, "`owner` is personal or team.");
  const hooks = body.environmentJson === undefined ? null : hooksFromEnvironmentJson(body.environmentJson);
  if (typeof hooks === "string") return apiError(400, hooks);
  if (hooks && (hooks.warm || hooks.start)) {
    const refused = boxSetupRefused(context);
    if (refused) return refused;
  }
  let ids: string[] | Response;
  if (Array.isArray(body.project_ids)) {
    ids = body.project_ids.every((id) => typeof id === "string" && isUuid(id)) ? (body.project_ids as string[]) : apiError(400, "`project_ids` are repositories' ids.");
  } else {
    ids = await repoIds(context, body.repos);
  }
  if (ids instanceof Response) return ids;
  let id: string;
  try {
    id = await createEnvironment(context.caller.userId, context.caller.orgId, body.name, ids);
  } catch (error) {
    const said = ruleError(error);
    if (said) return said;
    throw error;
  }
  await recordProjectChange(context.owner, id, "project.created");
  if (hooks && (hooks.warm || hooks.start)) {
    const set = await environmentPATCH(appRequest(context.base, `/api/environments/${id}`, { method: "PATCH", body: { hooks } }), routeParams({ id }));
    if (!set.ok) return errorFromRoute(set, context.base);
  }
  const made = await getEnvironment(context.caller.userId, id);
  if (!made) return apiError(500, "The project was made, but couldn't be read back.");
  return Response.json(await bothWays(context, made), { status: 201 });
}

/** DELETE /environments/{id}: archive a project the caller made (never a
 *  repository's own). An org key's: members' sessions start from it. */
export async function deleteEnvironmentApi(context: ApiContext, id: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  try {
    await archiveEnvironment(context.caller.userId, id);
  } catch (error) {
    const said = ruleError(error);
    if (said) return said;
    throw error;
  }
  await recordProjectChange(context.owner, id, "project.deleted", {}, project);
  return Response.json({ id });
}

/**
 * Cursor's PATCH fields, as Outrunner's: `environmentJson` its hooks,
 * `buildSettings` (nothing to set: ready boxes are made again on every
 * change), `repos` the repositories it holds, added and removed to match
 * (done here). Answers the body Outrunner's PATCH then takes, or the answer
 * to give.
 */
export async function cursorPatchOf(
  context: ApiContext,
  id: string,
  body: Record<string, unknown>,
): Promise<{ rest: Record<string, unknown> } | Response> {
  const rest = { ...body };
  if (rest.buildSettings !== undefined) {
    const settings = rest.buildSettings;
    delete rest.buildSettings;
    if (settings !== null && (typeof settings !== "object" || Array.isArray(settings))) return apiError(400, "`buildSettings` is an object.");
    if ((settings as Record<string, unknown> | null)?.pullLatestCode === "always") return apiError(400, "`pullLatestCode` is when_stale or never.");
  }
  if (rest.environmentJson !== undefined) {
    const hooks = hooksFromEnvironmentJson(rest.environmentJson);
    if (typeof hooks === "string") return apiError(400, hooks);
    delete rest.environmentJson;
    rest.hooks = hooks;
  }
  if (rest.repos !== undefined) {
    const refused = boxSetupRefused(context);
    if (refused) return refused;
    const wanted = await repoIds(context, rest.repos);
    if (wanted instanceof Response) return wanted;
    delete rest.repos;
    const project = await projectOf(context, id);
    if (project instanceof Response) return project;
    const have = new Set(project.repos.map((r) => r.projectId));
    for (const projectId of wanted.filter((p) => !have.has(p))) {
      const added = await reposPOST(appRequest(context.base, `/api/environments/${id}/repos`, { body: { projectId } }), routeParams({ id }));
      if (!added?.ok) return added ? errorFromRoute(added, context.base) : apiError(500, "Outrunner couldn't add a repository. Try again.");
    }
    for (const projectId of [...have].filter((p) => !wanted.includes(p))) {
      const removed = await reposDELETE(appRequest(context.base, `/api/environments/${id}/repos?projectId=${projectId}`, { method: "DELETE" }), routeParams({ id }));
      if (!removed?.ok) return removed ? errorFromRoute(removed, context.base) : apiError(500, "Outrunner couldn't remove a repository. Try again.");
    }
  }
  return { rest };
}

/** GET /environments/{id}/history: its changes, newest first (`limit`,
 *  `cursor`: the last item's id). */
export async function environmentHistoryApi(context: ApiContext, id: string): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const limitText = params.get("limit");
  const limit = limitText ? Number(limitText) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return apiError(400, "`limit` is a whole number from 1 to 100.");
  const cursor = params.get("cursor");
  if (cursor !== null && !/^\d{1,15}$/.test(cursor)) return apiError(400, "`cursor` is the `nextCursor` a page answered with.");
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const read = await listResourceAuditEvents(project.orgId, { type: PROJECT_RESOURCE, id }, { limit, before: cursor ? Number(cursor) : undefined });
  const items = read.events.map((event, i) => historyItemJson(event, describeAudit(event), !cursor && i === 0));
  return Response.json({ items, ...(read.more && read.events.length && { nextCursor: String(read.events[read.events.length - 1].id) }) });
}

/** GET /environments/{id}/builds: its build (`status` filters). */
export async function listBuildsApi(context: ApiContext, id: string): Promise<Response> {
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const status = new URL(context.request.url).searchParams.get("status");
  const build = cursorBuildJson(project);
  return Response.json({ items: build && (!status || build.status === status) ? [build] : [] });
}

/** GET /environments/{id}/builds/active and /builds/{build_id}. */
export async function getBuildApi(context: ApiContext, id: string, buildId: string | null): Promise<Response> {
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const build = cursorBuildJson(project);
  if (!build || (buildId !== null && build.id !== buildId)) return apiError(404, "No build by that id: only the project's latest is kept.");
  return Response.json(build);
}

/** POST /environments/{id}/builds: make its ready boxes again, its warm hook
 *  run anew ("Try again" on its settings page). */
export async function startBuildApi(context: ApiContext, id: string): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  if (body.draft === true || (Array.isArray(body.refs) && body.refs.length > 0)) {
    return apiError(400, "A build here is of the project's own branches: leave out `draft` and `refs`.");
  }
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const started = await warmPOST(appRequest(context.base, `/api/environments/${id}/warm`), routeParams({ id }));
  if (!started.ok) return errorFromRoute(started, context.base);
  const now = (await started.json()) as Environment | null;
  return Response.json({ id: `bld-${now?.setupGeneration ?? project.setupGeneration + 1}`, environmentId: id }, { status: 202 });
}

/** GET /environments/{id}/secrets: its variables, by name. */
export async function listEnvironmentSecretsApi(context: ApiContext, id: string): Promise<Response> {
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  return Response.json({ items: project.envNames.map((name) => projectSecretJson(project, name)), nextCursor: null });
}

/** PUT and DELETE /environments/{id}/secrets/{name}: set or remove one of
 *  its variables. An org key's, as every change to them is. */
export async function setEnvironmentSecretApi(context: ApiContext, id: string, name: string, remove: boolean): Promise<Response> {
  if (!SECRET_NAME.test(name) || !settableEnv(name)) return apiError(400, `${name} can't be set.`);
  let value: string | null = null;
  if (!remove) {
    const body = await jsonBody(context.request);
    if (body instanceof Response) return body;
    const put = secretPutOf(body);
    if (typeof put === "string") return apiError(400, put);
    if (put.repos?.length) return apiError(400, "A project's secrets are for all its repositories: leave out `repos`, or set a team secret for some.");
    value = put.value;
  }
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  if (remove && !project.envNames.includes(name)) return apiError(404, `The project has no ${name}.`);
  const edit = remove ? { removeEnv: [name] } : { setEnv: { [name]: value } };
  const edited = await secretsPATCH(appRequest(context.base, `/api/environments/${id}/secrets`, { method: "PATCH", body: edit }), routeParams({ id }));
  if (!edited.ok) return errorFromRoute(edited, context.base);
  if (remove) return Response.json({ name });
  const now = (await getEnvironment(context.caller.userId, id)) ?? project;
  return Response.json(projectSecretJson(now, name), { status: project.envNames.includes(name) ? 200 : 201 });
}

/** The org's secrets (an org key's to change), or the caller's own. */
function scopeOf(context: ApiContext, scope: "team" | "user"): SecretScope {
  return scope === "team" ? { kind: "team", orgId: context.caller.orgId } : { kind: "user", userId: context.caller.userId };
}

/** GET /team/secrets and /me/secrets: by name, never a value. */
export async function listScopedSecretsApi(context: ApiContext, scope: "team" | "user"): Promise<Response> {
  const paging = cursorPaging(new URL(context.request.url).searchParams);
  if (typeof paging === "string") return apiError(400, paging);
  const secrets = await listScopedSecrets(scopeOf(context, scope));
  const from = (paging.page - 1) * paging.perPage;
  return Response.json(cursorPage(secrets.slice(from, from + paging.perPage).map((s) => secretVersionJson(s)), { page: paging.page, has_more: from + paging.perPage < secrets.length }));
}

/** PUT and DELETE /team/secrets/{name} (an org key's: every member's
 *  sessions get them) and /me/secrets/{name} (the caller's own). */
export async function setScopedSecretApi(context: ApiContext, scope: "team" | "user", name: string, remove: boolean): Promise<Response> {
  if (!SECRET_NAME.test(name) || !settableEnv(name)) return apiError(400, `${name} can't be set.`);
  if (scope === "team") {
    const refused = boxSetupRefused(context);
    if (refused) return refused;
  }
  if (remove) {
    return (await deleteScopedSecret(scopeOf(context, scope), name)) ? Response.json({ name }) : apiError(404, `No secret named ${name}.`);
  }
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const put = secretPutOf(body);
  if (typeof put === "string") return apiError(400, put);
  const { secret, created } = await putScopedSecret(scopeOf(context, scope), name, { ...put, createdBy: context.caller.userId });
  return Response.json(secretVersionJson(secret), { status: created ? 201 : 200 });
}

/** GET /secrets: the org's (`scope=team`), the caller's own (`user`), or a
 *  project's (`environment`, with `environmentId`); all three's, without a
 *  scope. `name` and `repo` filter. */
export async function listAllSecretsApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const scope = params.get("scope");
  if (scope === "members") return apiError(400, "Members' own secrets are theirs alone here: each lists their own with `scope=user`.");
  if (scope !== null && !["team", "user", "environment"].includes(scope)) return apiError(400, "`scope` is team, user or environment.");
  const environmentId = params.get("environmentId");
  if (scope === "environment" && !environmentId) return apiError(400, "Name the project (`environmentId`).");
  const paging = cursorPaging(params);
  if (typeof paging === "string") return apiError(400, paging);
  const items: Record<string, unknown>[] = [];
  if (!scope || scope === "team") {
    for (const s of await listScopedSecrets(scopeOf(context, "team"))) items.push(secretVersionJson(s, { type: "team" }));
  }
  if (!scope || scope === "user") {
    for (const s of await listScopedSecrets(scopeOf(context, "user"))) items.push(secretVersionJson(s, { type: "user", user: { email: context.owner.email } }));
  }
  if (environmentId) {
    const project = await projectOf(context, environmentId);
    if (project instanceof Response) return project;
    for (const name of project.envNames) items.push(projectSecretJson(project, name, true));
  }
  const name = params.get("name");
  const repo = params.get("repo")?.toLowerCase();
  const filtered = items.filter(
    (s) => (!name || s.name === name) && (!repo || (s.repos as string[]).length === 0 || (s.repos as string[]).some((r) => repo.endsWith(r))),
  );
  const from = (paging.page - 1) * paging.perPage;
  const page = filtered.slice(from, from + paging.perPage);
  return Response.json({ items: page, nextCursor: from + paging.perPage < filtered.length ? String(paging.page + 1) : null });
}

/**
 * The public API's projects (docs/api.md): read one in full, change its
 * name, description, instructions, scripts and hooks, set and remove its
 * variables and files, and add or remove its repositories. Each change is
 * the project settings page's own route (app/api/environments/[id]), run as
 * the key's maker, so Roles & access hold as in the app. Values are
 * write-only: nothing here answers one back.
 */

import { GET as environmentGET, PATCH as environmentPATCH } from "@/app/api/environments/[id]/route";
import { DELETE as reposDELETE, POST as reposPOST } from "@/app/api/environments/[id]/repos/route";
import { PATCH as secretsPATCH } from "@/app/api/environments/[id]/secrets/route";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { environmentDetailJson } from "@/lib/api/serialize";
import { type Environment, getEnvironment } from "@/lib/db/environments";
import { isUuid } from "@/lib/ids";

const notFound = () => apiError(404, "No project by that id that you can see.");

/** The project, if it's in the key's org and the caller may see it. */
async function projectOf(context: ApiContext, id: string): Promise<Environment | Response> {
  if (!isUuid(id)) return notFound();
  const environment = await getEnvironment(context.caller.userId, id);
  return environment && environment.orgId === context.caller.orgId ? environment : notFound();
}

/** The project as it is now, read through the app's route. */
async function projectNow(context: ApiContext, id: string): Promise<Response> {
  const read = await environmentGET(appRequest(context.base, `/api/environments/${id}`, { method: "GET" }), routeParams({ id }));
  if (!read.ok) return errorFromRoute(read, context.base);
  return Response.json(environmentDetailJson((await read.json()) as Environment));
}

/** GET /environments/{id}. */
export async function getEnvironmentApi(context: ApiContext, id: string): Promise<Response> {
  const project = await projectOf(context, id);
  return project instanceof Response ? project : Response.json(environmentDetailJson(project));
}

/** The fields PATCH /environments/{id} takes, as the app's route does. */
const PROJECT_FIELDS = ["name", "description", "instructions", "scripts", "hooks"] as const;

/** PATCH /environments/{id}: a field left out is left as it is; null (or
 *  empty) clears one. */
export async function updateEnvironmentApi(context: ApiContext, id: string): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).find((key) => !(PROJECT_FIELDS as readonly string[]).includes(key));
  if (unknown) return apiError(400, `A project has no \`${unknown}\` to change: ${PROJECT_FIELDS.join(", ")}.`);
  if (Object.keys(body).length === 0) return apiError(400, `Name something to change: ${PROJECT_FIELDS.join(", ")}.`);
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const changed = await environmentPATCH(
    appRequest(context.base, `/api/environments/${id}`, { method: "PATCH", body }),
    routeParams({ id }),
  );
  if (!changed.ok) return errorFromRoute(changed, context.base);
  return projectNow(context, id);
}

/** The API's names for a variables-and-files change, as the route takes them. */
const SECRET_KEYS: Record<string, string> = {
  set_env: "setEnv",
  remove_env: "removeEnv",
  set_files: "setFiles",
  remove_files: "removeFiles",
};

/** PATCH /environments/{id}/secrets: set and remove variables and files.
 *  Answers the names and paths kept, never a value. */
export async function editEnvironmentSecretsApi(context: ApiContext, id: string): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const unknown = Object.keys(body).find((key) => !(key in SECRET_KEYS));
  if (unknown) return apiError(400, `Change variables and files with ${Object.keys(SECRET_KEYS).join(", ")}; not \`${unknown}\`.`);
  if (Object.keys(body).length === 0) return apiError(400, `Name a change: ${Object.keys(SECRET_KEYS).join(", ")}.`);
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const edit = Object.fromEntries(Object.entries(body).map(([key, value]) => [SECRET_KEYS[key], value]));
  const edited = await secretsPATCH(
    appRequest(context.base, `/api/environments/${id}/secrets`, { method: "PATCH", body: edit }),
    routeParams({ id }),
  );
  if (!edited.ok) return errorFromRoute(edited, context.base);
  const kept = (await edited.json()) as { envNames?: string[]; filePaths?: string[] };
  return Response.json({ variable_names: kept.envNames ?? [], file_paths: kept.filePaths ?? [] });
}

/** POST /environments/{id}/repos: add one of the org's repositories
 *  (`project_id`) to the project. */
export async function addEnvironmentRepoApi(context: ApiContext, id: string): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  if (typeof body.project_id !== "string" || !isUuid(body.project_id)) return apiError(400, "Name the repository to add (`project_id`).");
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const added = await reposPOST(
    appRequest(context.base, `/api/environments/${id}/repos`, { body: { projectId: body.project_id } }),
    routeParams({ id }),
  );
  if (!added) return apiError(500, "Outrunner couldn't add it. Try again.");
  if (!added.ok) return errorFromRoute(added, context.base);
  return projectNow(context, id);
}

/** DELETE /environments/{id}/repos/{project_id}: take a repository out of
 *  the project. */
export async function removeEnvironmentRepoApi(context: ApiContext, id: string, projectId: string): Promise<Response> {
  if (!isUuid(projectId)) return apiError(404, "No repository by that id in the project.");
  const project = await projectOf(context, id);
  if (project instanceof Response) return project;
  const removed = await reposDELETE(
    appRequest(context.base, `/api/environments/${id}/repos?projectId=${projectId}`, { method: "DELETE" }),
    routeParams({ id }),
  );
  if (!removed) return apiError(500, "Outrunner couldn't remove it. Try again.");
  if (!removed.ok) return errorFromRoute(removed, context.base);
  return projectNow(context, id);
}

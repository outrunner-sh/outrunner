/**
 * The public API's project skills (docs/api.md): each call is the project
 * page's own route (app/api/environments/[id]/…), run as the key's maker, so
 * the same rules and access hold. Lists come a page at a time; records and
 * refusals as every other endpoint gives them.
 */

import { DELETE as registryDELETE } from "@/app/api/environments/[id]/skill-registries/[registryId]/route";
import { GET as registriesGET, POST as registriesPOST } from "@/app/api/environments/[id]/skill-registries/route";
import { GET as repoSkillsGET } from "@/app/api/environments/[id]/repo-skills/route";
import { DELETE as skillDELETE } from "@/app/api/environments/[id]/skills/[skillId]/route";
import { GET as skillsGET, POST as skillsPOST } from "@/app/api/environments/[id]/skills/route";
import { GET as searchGET } from "@/app/api/skills/search/route";
import { boxSetupRefused } from "@/lib/api/auth";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { paginate, pageRequest } from "@/lib/api/pagination";
import { snakeKeys } from "@/lib/api/serialize";
import { isUuid } from "@/lib/ids";
import { projectNotFound } from "@/lib/api/project-access";

const notFound = projectNotFound;

/** A route's answer as the API gives it: `pick` the record, or the list
 *  paged; a refusal in the API's envelope. */
async function answer(
  context: ApiContext,
  response: Response,
  shape: { list: string } | { record: string } | { none: true },
): Promise<Response> {
  if (!response.ok) return errorFromRoute(response, context.base);
  if ("none" in shape) return new Response(null, { status: 204 });
  const data = (await response.json()) as Record<string, unknown>;
  if ("record" in shape) return Response.json(snakeKeys(data[shape.record]), { status: response.status });
  const page = pageRequest(new URL(context.request.url).searchParams);
  if (typeof page === "string") return apiError(400, page);
  const list = Array.isArray(data[shape.list]) ? (data[shape.list] as unknown[]) : [];
  return Response.json(paginate(list.map(snakeKeys), page));
}

/** GET /environments/{id}/skills: the catalog skills enabled on it. */
export async function listSkillsApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return notFound();
  const path = `/api/environments/${id}/skills`;
  return answer(context, await skillsGET(appRequest(context.base, path, { method: "GET" }), routeParams({ id })), { list: "skills" });
}

/** POST /environments/{id}/skills: enable a catalog skill, `{name, slug,
 *  source}` as GET /skills/search gave it. */
export async function enableSkillApi(context: ApiContext, id: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id)) return notFound();
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const path = `/api/environments/${id}/skills`;
  return answer(context, await skillsPOST(appRequest(context.base, path, { body }), routeParams({ id })), { record: "skill" });
}

/** DELETE /environments/{id}/skills/{skill_id}. */
export async function disableSkillApi(context: ApiContext, id: string, skillId: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id) || !isUuid(skillId)) return apiError(404, "No skill by that id on a project you can see.");
  const path = `/api/environments/${id}/skills/${skillId}`;
  return answer(context, await skillDELETE(appRequest(context.base, path, { method: "DELETE" }), routeParams({ id, skillId })), {
    none: true,
  });
}

/** GET /environments/{id}/skill-registries: each with the skills GitHub
 *  shows in it now. */
export async function listRegistriesApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return notFound();
  const path = `/api/environments/${id}/skill-registries`;
  return answer(context, await registriesGET(appRequest(context.base, path, { method: "GET" }), routeParams({ id })), {
    list: "registries",
  });
}

/** POST /environments/{id}/skill-registries: `{url}`, a GitHub repository. */
export async function addRegistryApi(context: ApiContext, id: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id)) return notFound();
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const path = `/api/environments/${id}/skill-registries`;
  const response = await registriesPOST(appRequest(context.base, path, { body }), routeParams({ id }));
  if (!response.ok) return errorFromRoute(response, context.base);
  const data = (await response.json()) as { registry: unknown; skills: unknown };
  return Response.json({ ...(snakeKeys(data.registry) as object), skills: snakeKeys(data.skills) }, { status: 201 });
}

/** DELETE /environments/{id}/skill-registries/{registry_id}. */
export async function removeRegistryApi(context: ApiContext, id: string, registryId: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id) || !isUuid(registryId)) return apiError(404, "No registry by that id on a project you can see.");
  const path = `/api/environments/${id}/skill-registries/${registryId}`;
  const response = await registryDELETE(appRequest(context.base, path, { method: "DELETE" }), routeParams({ id, registryId }));
  return answer(context, response, { none: true });
}

/** GET /environments/{id}/repo-skills: what its repositories commit. */
export async function listRepoSkillsApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return notFound();
  const path = `/api/environments/${id}/repo-skills`;
  return answer(context, await repoSkillsGET(appRequest(context.base, path, { method: "GET" }), routeParams({ id })), { list: "items" });
}

/** GET /skills/search?q=: the skills.sh catalog. */
export async function searchSkillsApi(context: ApiContext): Promise<Response> {
  const q = new URL(context.request.url).searchParams.get("q") ?? "";
  const path = `/api/skills/search?${new URLSearchParams({ q })}`;
  return answer(context, await searchGET(appRequest(context.base, path, { method: "GET" })), { list: "skills" });
}

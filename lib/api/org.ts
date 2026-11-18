/**
 * The public API's org (docs/api.md): its automations and their runs, its
 * cloud usage and its members, all in the key's org. Changing an automation
 * is its admins' (the Automations page's own routes, run as the key's maker:
 * an org key's maker is an admin); reading is any member's, as in the app.
 */

import { DELETE as automationDELETE, PATCH as automationPATCH } from "@/app/api/orgs/[id]/automations/[automationId]/route";
import { POST as automationsPOST } from "@/app/api/orgs/[id]/automations/route";
import { GET as usageGET } from "@/app/api/orgs/[id]/usage/route";
import { automationBody, automationsList, automationsPage } from "@/lib/api/automations";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { pageRequest, paginate } from "@/lib/api/pagination";
import { snakeKeys } from "@/lib/api/serialize";
import { getAutomation, listAutomations } from "@/lib/db/automations";
import { listRuns } from "@/lib/db/automation-runs";
import { listMembers } from "@/lib/db/org-members";
import { isUuid } from "@/lib/ids";

const noAutomation = () => apiError(404, "No automation by that id in this org.");

/** GET /automations: the org's automations, oldest first; in Cursor's
 *  `items` and `nextCursor` too (`limit` and `cursor` taken for `per_page`
 *  and `page`). */
export async function listAutomationsApi(context: ApiContext): Promise<Response> {
  const page = automationsPage(new URL(context.request.url).searchParams);
  if (typeof page === "string") return apiError(400, page);
  return Response.json(automationsList((await listAutomations(context.caller.orgId)).map(snakeKeys), page));
}

/** GET /automations/{id}. */
export async function getAutomationApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return noAutomation();
  const automation = await getAutomation(context.caller.orgId, id);
  return automation ? Response.json(snakeKeys(automation)) : noAutomation();
}

/** POST /automations: make one (an admin's). It runs as the key's maker.
 *  `model` (or Cursor's `modelSelection`) is the model its runs start on. */
export async function createAutomationApi(context: ApiContext): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const input = automationBody(body);
  if (typeof input === "string") return apiError(400, input);
  const org = context.caller.orgId;
  const made = await automationsPOST(
    appRequest(context.base, `/api/orgs/${org}/automations`, { body: input }),
    routeParams({ id: org }),
  );
  if (!made.ok) return errorFromRoute(made, context.base);
  const { id } = (await made.json()) as { id: string };
  const automation = await getAutomation(org, id);
  return automation ? Response.json(snakeKeys(automation), { status: 201 }) : apiError(500, "It was made, but couldn't be read back.");
}

/** PATCH /automations/{id}: change some of its fields (an admin's), its
 *  `model` among them (Cursor's `modelSelection` too; null clears it). */
export async function updateAutomationApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return noAutomation();
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return apiError(400, "Name something to change.");
  const input = automationBody(body);
  if (typeof input === "string") return apiError(400, input);
  const org = context.caller.orgId;
  const changed = await automationPATCH(
    appRequest(context.base, `/api/orgs/${org}/automations/${id}`, { method: "PATCH", body: input }),
    routeParams({ id: org, automationId: id }),
  );
  if (!changed.ok) return errorFromRoute(changed, context.base);
  return getAutomationApi(context, id);
}

/** DELETE /automations/{id} (an admin's). */
export async function deleteAutomationApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return noAutomation();
  const org = context.caller.orgId;
  const deleted = await automationDELETE(
    appRequest(context.base, `/api/orgs/${org}/automations/${id}`, { method: "DELETE" }),
    routeParams({ id: org, automationId: id }),
  );
  if (!deleted.ok) return errorFromRoute(deleted, context.base);
  return new Response(null, { status: 204 });
}

/** GET /automations/runs: the org's recent runs, newest first; one
 *  automation's with `automation_id`. */
export async function listAutomationRunsApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const page = pageRequest(params);
  if (typeof page === "string") return apiError(400, page);
  const only = params.get("automation_id");
  if (only !== null && !isUuid(only)) return apiError(400, "`automation_id` is an automation's id.");
  const runs = await listRuns(context.caller.orgId, undefined, only ?? undefined);
  return Response.json(paginate(runs.map(snakeKeys), page));
}

/** GET /usage: the org's cloud usage and its admins' controls on it. */
export async function usageApi(context: ApiContext): Promise<Response> {
  const org = context.caller.orgId;
  const read = await usageGET(appRequest(context.base, `/api/orgs/${org}/usage`, { method: "GET" }), routeParams({ id: org }));
  if (!read.ok) return errorFromRoute(read, context.base);
  return Response.json(snakeKeys(await read.json()));
}

/** GET /members: the org's people and their roles, admins first. Emails are
 *  for its admins. */
export async function listMembersApi(context: ApiContext): Promise<Response> {
  const page = pageRequest(new URL(context.request.url).searchParams);
  if (typeof page === "string") return apiError(400, page);
  const admin = context.caller.role === "admin";
  const members = (await listMembers(context.caller.orgId)).map((m) => ({
    user_id: m.userId,
    login: m.login,
    name: m.name,
    ...(admin && { email: m.email }),
    role: m.role,
    joined_at: m.joinedAt,
  }));
  return Response.json(paginate(members, page));
}

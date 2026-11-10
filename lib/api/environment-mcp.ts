/**
 * The public API's project MCP servers (docs/api.md): each call is the
 * project page's own route (app/api/environments/[id]/mcp-servers), run as
 * the key's maker, so the same rules and access hold. A value given is
 * never answered back: a server comes with its variables' and headers'
 * names only.
 */

import { DELETE as serverDELETE, PATCH as serverPATCH } from "@/app/api/environments/[id]/mcp-servers/[serverId]/route";
import { GET as serversGET, POST as serversPOST } from "@/app/api/environments/[id]/mcp-servers/route";
import { boxSetupRefused } from "@/lib/api/auth";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import { appRequest, jsonBody, routeParams, type ApiContext } from "@/lib/api/handler";
import { paginate, pageRequest } from "@/lib/api/pagination";
import { snakeKeys } from "@/lib/api/serialize";
import { isUuid } from "@/lib/ids";

const notFound = () => apiError(404, "No project by that id that you can see.");

/** The API's snake_case names for a change, as the route takes them. */
const EDIT_KEYS: Record<string, string> = {
  set_env: "setEnv",
  remove_env: "removeEnv",
  set_headers: "setHeaders",
  remove_headers: "removeHeaders",
};

/** GET /environments/{id}/mcp-servers. */
export async function listMcpServersApi(context: ApiContext, id: string): Promise<Response> {
  if (!isUuid(id)) return notFound();
  const page = pageRequest(new URL(context.request.url).searchParams);
  if (typeof page === "string") return apiError(400, page);
  const path = `/api/environments/${id}/mcp-servers`;
  const response = await serversGET(appRequest(context.base, path, { method: "GET" }), routeParams({ id }));
  if (!response.ok) return errorFromRoute(response, context.base);
  const { servers } = (await response.json()) as { servers: unknown[] };
  return Response.json(paginate(servers.map(snakeKeys), page));
}

/** POST /environments/{id}/mcp-servers. */
export async function createMcpServerApi(context: ApiContext, id: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id)) return notFound();
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const path = `/api/environments/${id}/mcp-servers`;
  const response = await serversPOST(appRequest(context.base, path, { body }), routeParams({ id }));
  if (!response.ok) return errorFromRoute(response, context.base);
  const { server } = (await response.json()) as { server: unknown };
  return Response.json(snakeKeys(server), { status: 201 });
}

/** PATCH /environments/{id}/mcp-servers/{server_id}. */
export async function updateMcpServerApi(context: ApiContext, id: string, serverId: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id) || !isUuid(serverId)) return apiError(404, "No MCP server by that id on a project you can see.");
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const edit = Object.fromEntries(Object.entries(body).map(([k, v]) => [EDIT_KEYS[k] ?? k, v]));
  const path = `/api/environments/${id}/mcp-servers/${serverId}`;
  const response = await serverPATCH(appRequest(context.base, path, { method: "PATCH", body: edit }), routeParams({ id, serverId }));
  if (!response.ok) return errorFromRoute(response, context.base);
  const { server } = (await response.json()) as { server: unknown };
  return Response.json(snakeKeys(server));
}

/** DELETE /environments/{id}/mcp-servers/{server_id}. */
export async function deleteMcpServerApi(context: ApiContext, id: string, serverId: string): Promise<Response> {
  const refused = boxSetupRefused(context);
  if (refused) return refused;
  if (!isUuid(id) || !isUuid(serverId)) return apiError(404, "No MCP server by that id on a project you can see.");
  const path = `/api/environments/${id}/mcp-servers/${serverId}`;
  const response = await serverDELETE(appRequest(context.base, path, { method: "DELETE" }), routeParams({ id, serverId }));
  if (!response.ok) return errorFromRoute(response, context.base);
  return new Response(null, { status: 204 });
}

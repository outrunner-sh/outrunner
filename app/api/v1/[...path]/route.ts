import { apiError } from "@/lib/api/errors";

/** A path under /api/v1 the API has no endpoint at: said in its envelope,
 *  not the app's page. Every endpoint is in /api/v1/openapi.json. */
function noEndpoint(request: Request): Response {
  const path = new URL(request.url).pathname;
  return apiError(404, `There's no ${request.method} ${path} in the API: /api/v1/openapi.json lists every endpoint.`);
}

export { noEndpoint as GET, noEndpoint as POST, noEndpoint as PUT, noEndpoint as PATCH, noEndpoint as DELETE };

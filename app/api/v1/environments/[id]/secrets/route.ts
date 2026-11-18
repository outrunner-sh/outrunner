import { listEnvironmentSecretsApi } from "@/lib/api/cursor-environments.deps";
import { editEnvironmentSecretsApi } from "@/lib/api/environments";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** Its variables, by name, as Cursor lists an environment's secrets. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listEnvironmentSecretsApi(api, id));
}

/** Set and remove a project's variables and files; write-only. (docs/api.md) */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => editEnvironmentSecretsApi(api, id));
}

import { editEnvironmentSecretsApi } from "@/lib/api/environments";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** Set and remove a project's variables and files; write-only. (docs/api.md) */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => editEnvironmentSecretsApi(api, id));
}

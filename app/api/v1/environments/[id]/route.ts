import { deleteEnvironmentApi } from "@/lib/api/cursor-environments.deps";
import { getEnvironmentApi, updateEnvironmentApi } from "@/lib/api/environments";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** A project in full. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getEnvironmentApi(api, id));
}

/** Change a project's name, description, instructions, scripts or hooks. (docs/api.md) */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => updateEnvironmentApi(api, id));
}

/** Delete (archive) a project someone made; never a repository's own. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => deleteEnvironmentApi(api, id));
}

import { removeEnvironmentRepoApi } from "@/lib/api/environments";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; projectId: string }> };

/** Take a repository out of a project. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, projectId } = await context.params;
  return apiRoute(request, (api) => removeEnvironmentRepoApi(api, id, projectId));
}

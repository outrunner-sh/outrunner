import { removeRegistryApi } from "@/lib/api/environment-skills";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; registryId: string }> };

/** Remove one of a project's skill registries. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, registryId } = await context.params;
  return apiRoute(request, (api) => removeRegistryApi(api, id, registryId));
}

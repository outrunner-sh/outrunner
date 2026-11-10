import { removeRegistryApi } from "@/lib/api/environment-skills";
import { projectApiRoute } from "@/lib/api/environment-org.deps";

type RouteContext = { params: Promise<{ id: string; registryId: string }> };

/** Remove one of a project's skill registries. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, registryId } = await context.params;
  return projectApiRoute(request, id, (api) => removeRegistryApi(api, id, registryId));
}

import { removeRegistryApi } from "@/lib/api/environment-skills";
import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; registryId: string }> };

/** Remove one of a project's skill registries. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, registryId } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? removeRegistryApi(api, id, registryId));
}

import { setScopedSecretApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ name: string }> };

/** Set one (`value`, `type`, `repos`): the caller's own. */
export async function PUT(request: Request, context: RouteContext) {
  const { name } = await context.params;
  return apiRoute(request, (api) => setScopedSecretApi(api, "user", name, false));
}

/** Remove one: the caller's own. */
export async function DELETE(request: Request, context: RouteContext) {
  const { name } = await context.params;
  return apiRoute(request, (api) => setScopedSecretApi(api, "user", name, true));
}

import { setScopedSecretApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ name: string }> };

/** Set one (`value`, `type`, `repos`): an org key's. */
export async function PUT(request: Request, context: RouteContext) {
  const { name } = await context.params;
  return apiRoute(request, (api) => setScopedSecretApi(api, "team", name, false));
}

/** Remove one: an org key's. */
export async function DELETE(request: Request, context: RouteContext) {
  const { name } = await context.params;
  return apiRoute(request, (api) => setScopedSecretApi(api, "team", name, true));
}

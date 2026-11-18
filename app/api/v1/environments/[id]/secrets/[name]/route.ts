import { setEnvironmentSecretApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; name: string }> };

/** Set one of the project's variables (`value`): an org key's. */
export async function PUT(request: Request, context: RouteContext) {
  const { id, name } = await context.params;
  return apiRoute(request, (api) => setEnvironmentSecretApi(api, id, name, false));
}

/** Remove one of its variables: an org key's. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, name } = await context.params;
  return apiRoute(request, (api) => setEnvironmentSecretApi(api, id, name, true));
}

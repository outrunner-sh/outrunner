import { apiRoute } from "@/lib/api/handler";
import { secretsApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** Give the session's agent the secrets it asked for (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => secretsApi(api, id));
}

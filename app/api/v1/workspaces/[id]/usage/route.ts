import { apiRoute } from "@/lib/api/handler";
import { usageApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** The tokens the session spent, in all and by run (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => usageApi(api, id));
}

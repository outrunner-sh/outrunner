import { apiRoute } from "@/lib/api/handler";
import { cancelRunApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

/** Stop the run, when it's the one going on (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id, runId } = await context.params;
  return apiRoute(request, (api) => cancelRunApi(api, id, runId));
}

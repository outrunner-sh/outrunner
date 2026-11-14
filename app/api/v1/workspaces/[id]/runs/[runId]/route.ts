import { apiRoute } from "@/lib/api/handler";
import { getRunApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

/** One of the session's runs: its status, result, duration and tokens (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id, runId } = await context.params;
  return apiRoute(request, (api) => getRunApi(api, id, runId));
}

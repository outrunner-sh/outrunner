import { cancelAgentRunApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

/** Stop the run, when it's the one going on. */
export async function POST(request: Request, context: RouteContext) {
  const { id, runId } = await context.params;
  return apiRoute(request, (api) => cancelAgentRunApi(api, id, runId));
}

import { getAgentRunApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

/** One of the agent's runs, as Cursor's API answers it. */
export async function GET(request: Request, context: RouteContext) {
  const { id, runId } = await context.params;
  return apiRoute(request, (api) => getAgentRunApi(api, id, runId));
}

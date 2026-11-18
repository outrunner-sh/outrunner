import { agentUsageApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The tokens the agent spent, in all and by run (`runId`: one), in Cursor's words. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => agentUsageApi(api, id));
}

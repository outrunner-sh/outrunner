import { apiRoute } from "@/lib/api/handler";
import { answerApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** Answer the question the session's agent is waiting on (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => answerApi(api, id));
}

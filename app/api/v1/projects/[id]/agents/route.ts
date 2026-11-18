import { projectAgentsApi } from "@/lib/api/cursor-projects.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The project's agents: its coordinator and its Ships. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => projectAgentsApi(api, id));
}

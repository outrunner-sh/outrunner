import { agentLifecycleApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// As the session page's lifecycle route (a box to start or snapshot).
export const maxDuration = 60;

/** Restore the agent's archived session. */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => agentLifecycleApi(api, id, "resume"));
}

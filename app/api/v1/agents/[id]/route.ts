import { agentLifecycleApi, getAgentApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// Deleting goes through the session page's lifecycle route.
export const maxDuration = 60;

/** The agent, as Cursor's API answers it (lib/api/cursor.ts). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getAgentApi(api, id));
}

/** Delete the agent's session for good. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => agentLifecycleApi(api, id, "delete"));
}

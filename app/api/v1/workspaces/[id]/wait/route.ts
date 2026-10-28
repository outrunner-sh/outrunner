import { apiRoute } from "@/lib/api/handler";
import { waitApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

// Held open until the turn is over, up to ten minutes (a no-op on the
// long-running server Outrunner runs as, a cap on a serverless host).
export const maxDuration = 660;

/** Hold the call until the session's turn is idle or needs input (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => waitApi(api, id));
}

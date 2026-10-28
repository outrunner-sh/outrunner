import { apiRoute } from "@/lib/api/handler";
import { getWorkspaceApi, lifecycleApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

// A delete tears the session's box down, as the session page's does.
export const maxDuration = 60;

/** The session, and where its turn is (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getWorkspaceApi(api, id));
}

/** Delete the session for good: its box, its worktree, its snapshots. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => lifecycleApi(api, id, "delete"));
}

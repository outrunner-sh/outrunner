import { apiRoute } from "@/lib/api/handler";
import { pullRequestsApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** The session's pull requests, one per repository, with their status (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => pullRequestsApi(api, id));
}

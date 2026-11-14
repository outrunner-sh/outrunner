import { apiRoute } from "@/lib/api/handler";
import { listRunsApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** The session's runs, one per prompt, newest first (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listRunsApi(api, id));
}

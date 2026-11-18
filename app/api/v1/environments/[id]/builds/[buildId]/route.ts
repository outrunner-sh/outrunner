import { getBuildApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; buildId: string }> };

/** One build of the project: its latest is the one kept. */
export async function GET(request: Request, context: RouteContext) {
  const { id, buildId } = await context.params;
  return apiRoute(request, (api) => getBuildApi(api, id, buildId));
}

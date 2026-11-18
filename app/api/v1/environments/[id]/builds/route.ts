import { listBuildsApi, startBuildApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The project's build: its ready boxes, and how its warm hook went. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listBuildsApi(api, id));
}

/** Make its ready boxes again, its warm hook run anew. */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => startBuildApi(api, id));
}

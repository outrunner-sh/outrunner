import { apiRoute } from "@/lib/api/handler";
import { changesApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** The files the session changed, or one file's diff with `path` (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => changesApi(api, id));
}

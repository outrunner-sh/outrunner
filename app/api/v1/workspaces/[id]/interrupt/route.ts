import { apiRoute } from "@/lib/api/handler";
import { interruptApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** Stop the turn the session is running (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => interruptApi(api, id));
}

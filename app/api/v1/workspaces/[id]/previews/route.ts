import { apiRoute } from "@/lib/api/handler";
import { createPreviewApi, listPreviewsApi } from "@/lib/api/previews";

type RouteContext = { params: Promise<{ id: string }> };

/** The session's previews: links to servers on its box (docs/api.md#previews). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listPreviewsApi(api, id));
}

/** Make a preview of a port, or get the one it has. */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => createPreviewApi(api, id));
}

import { getTriageApi } from "@/lib/api/catalog";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** One work item (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getTriageApi(api, id));
}

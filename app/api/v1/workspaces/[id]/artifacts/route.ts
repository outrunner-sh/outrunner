import { listArtifactsApi } from "@/lib/api/artifacts.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The screenshots and recordings the session's agent uploaded (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listArtifactsApi(api, id));
}

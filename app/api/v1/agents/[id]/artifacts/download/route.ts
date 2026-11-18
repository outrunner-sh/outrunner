import { agentArtifactDownloadApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** A link to one artifact's bytes (`path`), for 15 minutes. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => agentArtifactDownloadApi(api, id));
}

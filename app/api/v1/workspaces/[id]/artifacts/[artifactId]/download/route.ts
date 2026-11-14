import { downloadArtifactApi } from "@/lib/api/artifacts.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; artifactId: string }> };

/** A link to one artifact's bytes, for 15 minutes (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id, artifactId } = await context.params;
  return apiRoute(request, (api) => downloadArtifactApi(api, id, artifactId));
}

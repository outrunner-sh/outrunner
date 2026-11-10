import { addEnvironmentRepoApi } from "@/lib/api/environments";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** Add one of the org's repositories to a project. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => addEnvironmentRepoApi(api, id));
}

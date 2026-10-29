import { apiRoute } from "@/lib/api/handler";
import { deleteLearningApi, getLearningApi, updateLearningApi } from "@/lib/api/learnings";

type RouteContext = { params: Promise<{ id: string }> };

/** One learning (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getLearningApi(api, id));
}

/** Change it, or accept a suggestion. */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => updateLearningApi(api, id));
}

/** Delete it, or dismiss a suggestion. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => deleteLearningApi(api, id));
}

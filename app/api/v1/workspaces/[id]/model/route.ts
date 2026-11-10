import { apiRoute } from "@/lib/api/handler";
import { switchModelApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

// The agent relaunches on the new model before it answers.
export const maxDuration = 60;

/** Switch the session to another model, or effort (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => switchModelApi(api, id));
}

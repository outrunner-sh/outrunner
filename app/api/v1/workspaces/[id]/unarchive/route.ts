import { apiRoute } from "@/lib/api/handler";
import { lifecycleApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

// As the session page's lifecycle route (a box to start or snapshot).
export const maxDuration = 60;

/** Restore an archived session: resume, by the name clients written for
 *  Cursor's API call it (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => lifecycleApi(api, id, "resume"));
}

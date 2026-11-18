import { unarchiveCursorProjectApi } from "@/lib/api/cursor-projects.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// As the session page's lifecycle route (a box to restore).
export const maxDuration = 60;

/** Unarchive the project: restore the Mission's own session. */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => unarchiveCursorProjectApi(api, id));
}

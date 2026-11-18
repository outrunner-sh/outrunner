import { archiveCursorProjectApi } from "@/lib/api/cursor-projects.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// As POST /api/missions/[id]/archive: each Ship's worktree is saved as it's
// archived, and none is started on past two minutes.
export const maxDuration = 300;

/** Archive the project: the Mission with its Ships. */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => archiveCursorProjectApi(api, id));
}

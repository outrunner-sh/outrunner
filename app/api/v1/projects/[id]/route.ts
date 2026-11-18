import { getCursorProjectApi, patchCursorProjectApi } from "@/lib/api/cursor-projects.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The project (a Mission), as Cursor's API answers it (lib/api/cursor-projects.ts). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getCursorProjectApi(api, id));
}

/** Rename the project, or give it another icon. */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => patchCursorProjectApi(api, id));
}

import { listCursorProjectsApi } from "@/lib/api/cursor-projects.deps";
import { apiRoute } from "@/lib/api/handler";

/** The caller's Missions, as Cursor's API lists projects (GET /v1/projects;
 *  /api/v1/projects lists repositories here). */
export function GET(request: Request) {
  return apiRoute(request, listCursorProjectsApi);
}

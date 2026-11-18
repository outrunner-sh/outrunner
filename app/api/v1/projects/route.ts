import { listProjectsApi } from "@/lib/api/catalog";
import { createProjectApi } from "@/lib/api/cursor-projects.deps";
import { apiRoute } from "@/lib/api/handler";
import { CREATE_LIMIT } from "@/lib/api/rate-limit";

// As POST /workspaces: answered once the Mission's row is made.
export const maxDuration = 60;

/** The org's repositories the key's maker may start sessions on (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listProjectsApi);
}

/** Start a project (a Mission) from Cursor's create request
 *  (lib/api/cursor-projects.ts); Cursor's project list is GET /missions. */
export function POST(request: Request) {
  return apiRoute(request, createProjectApi, { limit: CREATE_LIMIT, bucket: "create" });
}

import { listEnvironmentsApi } from "@/lib/api/catalog";
import { createEnvironmentApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

/** The org's projects (environments) the key's maker may read (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listEnvironmentsApi);
}

/** Make a project of some of the org's repositories: `name`, `repos`
 *  (Cursor's `[{ url }]`) or `project_ids`, and Cursor's `environmentJson`
 *  (docs/cursor-migration.md). */
export function POST(request: Request) {
  return apiRoute(request, createEnvironmentApi);
}

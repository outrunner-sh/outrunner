import { apiRoute } from "@/lib/api/handler";
import { CREATE_LIMIT } from "@/lib/api/rate-limit";
import { createWorkspace, listWorkspaces } from "@/lib/api/workspaces";

// The create answers once the session's row is made; its box is set up in
// after(), as the new-session screen's is (app/api/projects/[id]/workspaces).
export const maxDuration = 60;

/** Sessions in the org, filtered and paged (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listWorkspaces);
}

/** Start a session: `preparing` at once, its prompt sent once it's ready. */
export function POST(request: Request) {
  return apiRoute(request, (context) => createWorkspace(context), { limit: CREATE_LIMIT, bucket: "create" });
}

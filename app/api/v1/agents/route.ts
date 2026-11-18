import { createAgentApi, listAgentsApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";
import { CREATE_LIMIT } from "@/lib/api/rate-limit";

// As POST /workspaces: answered once the session's row is made.
export const maxDuration = 60;

/** The caller's agents, as Cursor's API lists them (lib/api/cursor.ts). */
export function GET(request: Request) {
  return apiRoute(request, listAgentsApi);
}

/** Start an agent from Cursor's create request: a session, and its first run. */
export function POST(request: Request) {
  return apiRoute(request, createAgentApi, { limit: CREATE_LIMIT, bucket: "create" });
}

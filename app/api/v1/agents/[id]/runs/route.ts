import { followUpApi, listAgentRunsApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// Waking a paused or archived session first can take most of a minute.
export const maxDuration = 60;

/** The agent's runs, newest first, as Cursor's API lists them. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listAgentRunsApi(api, id));
}

/** A follow-up in the agent's thread: a new run (or, with `delivery: steer`,
 *  the run going on told it). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => followUpApi(api, id));
}

import { runRef } from "@/lib/api/cursor";
import { apiRoute } from "@/lib/api/handler";
import { streamApi } from "@/lib/api/stream.deps";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

// Held open while the run goes on, up to MAX_STREAM_MS (lib/api/stream.deps.ts).
export const maxDuration = 900;

/** One run's events as they happen, over SSE, ending with its result
 *  (docs/api.md). A run named by its place (`run-1`) that hasn't begun, as
 *  a session just started has, is waited for. */
export async function GET(request: Request, context: RouteContext) {
  const { id, runId } = await context.params;
  const ref = runRef(runId);
  return apiRoute(request, (api) => streamApi(api, id, ref && "number" in ref ? ref : runId));
}

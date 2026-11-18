import { streamAgentRunApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; runId: string }> };

// Held open while the run goes on, up to MAX_STREAM_MS (lib/api/stream.deps.ts).
export const maxDuration = 900;

/** One run's events as they happen, over SSE, in Cursor's words, ending
 *  with its result; a run not begun yet is waited for. */
export async function GET(request: Request, context: RouteContext) {
  const { id, runId } = await context.params;
  return apiRoute(request, (api) => streamAgentRunApi(api, id, runId));
}

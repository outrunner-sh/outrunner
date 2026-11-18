import { streamAgentApi } from "@/lib/api/cursor.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// Held open while the agent works, up to MAX_STREAM_MS (lib/api/stream.deps.ts).
export const maxDuration = 900;

/** The agent's events across its runs, over SSE, in Cursor's words. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => streamAgentApi(api, id));
}

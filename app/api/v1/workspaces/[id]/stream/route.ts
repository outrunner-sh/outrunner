import { apiRoute } from "@/lib/api/handler";
import { streamApi } from "@/lib/api/stream.deps";

type RouteContext = { params: Promise<{ id: string }> };

// Held open while the session works, up to MAX_STREAM_MS (lib/api/stream.deps.ts).
export const maxDuration = 900;

/** The session's events as they happen, over SSE: its runs' prompts, words,
 *  tool calls and results (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => streamApi(api, id));
}

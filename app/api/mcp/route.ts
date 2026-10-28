import { apiError } from "@/lib/api/errors";
import { apiRoute, takeLimit } from "@/lib/api/handler";
import { DEFAULT_LIMIT, rateHeaders } from "@/lib/api/rate-limit";
import { apiMcpServer } from "@/lib/mcp/api-tools";
import { rpcResponse, toolCallCount } from "@/lib/mcp/server";

// A wait_for_workspace call holds the request until the session's turn is
// over, up to ten minutes.
export const maxDuration = 660;

/**
 * Outrunner's MCP server (streamable HTTP, JSON answers): the API's
 * operations as tools (lib/mcp/api-tools.ts), signed in with an API key as
 * the REST API is (`Authorization: Bearer or_key_…`).
 */
export async function POST(request: Request) {
  return apiRoute(request, async (context) => {
    const text = await request.text();
    // The call itself took one of the key's calls; each tool call past the
    // first in a batch takes one more, so a batch is no way around the limit.
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Answered by the server as the protocol's parse error.
    }
    for (let extra = toolCallCount(body) - 1; extra > 0; extra--) {
      const decision = takeLimit(context.caller, DEFAULT_LIMIT, "default");
      if (!decision.allowed) {
        return apiError(429, `Too many calls. Try again in ${Math.max(1, decision.retryAfter)}s.`, { headers: rateHeaders(decision) });
      }
    }
    return rpcResponse(await apiMcpServer.handleText(text, context));
  });
}

/** No stream to open: every answer comes back on its POST. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

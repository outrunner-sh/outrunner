import { apiRoute } from "@/lib/api/handler";
import { apiMcpServer } from "@/lib/mcp/api-tools";
import { rpcResponse } from "@/lib/mcp/server";

// A wait_for_workspace call holds the request until the session's turn is
// over, up to ten minutes.
export const maxDuration = 660;

/**
 * Outrunner's MCP server (streamable HTTP, JSON answers): the API's
 * operations as tools (lib/mcp/api-tools.ts), signed in with an API key as
 * the REST API is (`Authorization: Bearer or_key_…`).
 */
export async function POST(request: Request) {
  return apiRoute(request, async (context) => rpcResponse(await apiMcpServer.handleText(await request.text(), context)));
}

/** No stream to open: every answer comes back on its POST. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

import { answerMissionMcp } from "@/lib/missions/server";

/** Tool calls wait on GitHub and on boxes: a list of 20 Runners' pull
 *  requests takes a while. */
export const maxDuration = 120;

/**
 * A Mission's tools for its Runners (lib/missions/tools.ts), as an MCP server
 * over Streamable HTTP (lib/missions/server.ts). Its agent calls it with the
 * token minted for its box (lib/missions/setup.ts), which names that Mission
 * and nothing else. /api/mcp answers a Mission's token the same way.
 */
export async function POST(request: Request) {
  return answerMissionMcp(request);
}

/** No server-sent stream: everything is answered in the POST's response. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

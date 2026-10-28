import { NextResponse } from "next/server";

import { readBearer } from "@/lib/http/bearer";
import { handleMcpBody } from "@/lib/missions/mcp";
import { missionMcpServer } from "@/lib/missions/server";
import { missionTokens } from "@/lib/missions/store";
import { missionForToken } from "@/lib/missions/token";

/** Tool calls wait on GitHub and on boxes: a list of 20 Runners' pull
 *  requests takes a while. */
export const maxDuration = 120;

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * A Mission's tools for its Runners (lib/missions/tools.ts), as an MCP server
 * over Streamable HTTP (lib/missions/mcp.ts). Its agent calls it with the
 * token minted for its box (lib/missions/setup.ts), which names that Mission
 * and nothing else.
 */
export async function POST(request: Request) {
  const missionId = await missionForToken(readBearer(request.headers.get("authorization")), missionTokens).catch(() => null);
  if (!missionId) {
    return NextResponse.json({ error: "Not a Mission's token." }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const answer = await handleMcpBody(body, missionMcpServer({ missionId }));
  if (answer === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(answer);
}

/** No server-sent stream: everything is answered in the POST's response. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { allow: "POST" } });
}

/**
 * The Mission's tools (lib/missions/tools.ts) as an MCP server, on the app's
 * one MCP server code (lib/mcp/server.ts): a registry of tools over a
 * Mission's scope, which its token names. Served at /api/missions/mcp, where
 * its box's MCP config points, and at /api/mcp for a call that carries a
 * Mission's token rather than an API key, so either reaches exactly that
 * Mission's Runners.
 */

import { DEFAULT_LIMIT, RateLimiter, rateHeaders } from "@/lib/api/rate-limit";
import { MAX_BATCH, McpServer, rpcResponse, toolCallCount, toolResult, type JsonSchema, type McpTool } from "@/lib/mcp/server";
import { readBearer } from "@/lib/http/bearer";
import { MISSION_SERVER_INSTRUCTIONS } from "@/lib/missions/prompt";
import { MISSION_MCP_SERVER } from "@/lib/missions/setup";
import { callMissionTool, MISSION_TOOLS, type MissionScope, type MissionToolDeps } from "@/lib/missions/tools";
import { isMissionToken, missionForToken } from "@/lib/missions/token";

/** The Mission's tools for the MCP server, run with `deps` as each call's. */
export function missionMcpTools(deps: () => MissionToolDeps): McpTool<MissionScope>[] {
  return MISSION_TOOLS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as JsonSchema,
    call: async (scope, args) => {
      try {
        const result = await callMissionTool(scope, definition.name, args, deps());
        return toolResult(result.text, result.isError ?? false);
      } catch (error) {
        // The tool's own failure, said to the agent, not the protocol's.
        console.error(`Mission ${scope.missionId}: ${definition.name} failed`, error);
        return toolResult("That failed on Outrunner's side, and it logged why. Try again shortly.", true);
      }
    },
  }));
}

export function missionMcpServerWith(deps: () => MissionToolDeps): McpServer<MissionScope> {
  return new McpServer<MissionScope>(
    { name: MISSION_MCP_SERVER, version: "1", instructions: MISSION_SERVER_INSTRUCTIONS },
    missionMcpTools(deps),
  );
}

let server: Promise<McpServer<MissionScope>> | null = null;

/** The Mission's MCP server, its tools wired to the database and the boxes.
 *  Loaded on first use (the wiring pulls the app's routes in), once: two
 *  calls at once share it. */
export function missionMcpServer(): Promise<McpServer<MissionScope>> {
  server ??= import("@/lib/missions/tools.deps").then(({ missionToolDeps }) => missionMcpServerWith(missionToolDeps));
  return server;
}

/** Whether a call's Authorization names a Mission's token (`orm_…`), rather
 *  than an API key: which of the two MCP servers /api/mcp answers it with. */
export function carriesMissionToken(authorization: string | null): boolean {
  return isMissionToken(readBearer(authorization));
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Each Mission's calls, held to the API's own rate (per minute, counting
 *  each tool call of a batch), whichever of its two routes it calls. */
const limiter = new RateLimiter();

/**
 * Answer an MCP POST signed with a Mission's token: refused unless the token
 * names a Mission (and said as unavailable, not refused, when it couldn't be
 * looked up), held to its rate, then answered in that Mission's scope alone.
 */
export async function answerMissionMcp(request: Request): Promise<Response> {
  const { missionTokens } = await import("@/lib/missions/store");
  let missionId: string | null;
  try {
    missionId = await missionForToken(readBearer(request.headers.get("authorization")), missionTokens);
  } catch (error) {
    // Not the token's fault: a 401 here could make the agent give the
    // server up for the rest of its session.
    console.error("Mission MCP: couldn't look the token up", error);
    return Response.json({ error: "Outrunner couldn't check that just now. Try again shortly." }, { status: 503 });
  }
  if (!missionId) {
    return Response.json({ error: "Not a Mission's token." }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "Too large." }, { status: 413 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return Response.json({ error: "Too large." }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Answered by the server as the protocol's parse error.
  }
  const calls = Array.isArray(body) && body.length > MAX_BATCH ? 1 : Math.max(1, toolCallCount(body));
  const decision = limiter.take(`mission:${missionId}`, DEFAULT_LIMIT, calls);
  if (!decision.allowed) {
    return Response.json(
      { error: `Too many calls. Try again in ${Math.max(1, decision.retryAfter)}s.` },
      { status: 429, headers: rateHeaders(decision) },
    );
  }
  const response = rpcResponse(await (await missionMcpServer()).handleText(text, { missionId }));
  for (const [name, value] of Object.entries(rateHeaders(decision))) response.headers.set(name, value);
  return response;
}

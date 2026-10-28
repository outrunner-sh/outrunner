/**
 * The Mission's tools (lib/missions/tools.ts) as an MCP server, on the app's
 * one MCP server code (lib/mcp/server.ts): a registry of tools over a
 * Mission's scope, which its token names. Served at /api/missions/mcp, where
 * its box's MCP config points, and at /api/mcp for a call that carries a
 * Mission's token rather than an API key, so either reaches exactly that
 * Mission's Runners.
 */

import { McpServer, rpcResponse, toolResult, type JsonSchema, type McpTool } from "@/lib/mcp/server";
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

let server: McpServer<MissionScope> | null = null;

/** The Mission's MCP server, its tools wired to the database and the boxes.
 *  Loaded on first use: the wiring pulls the app's routes in. */
export async function missionMcpServer(): Promise<McpServer<MissionScope>> {
  if (!server) {
    const { missionToolDeps } = await import("@/lib/missions/tools.deps");
    server = missionMcpServerWith(missionToolDeps);
  }
  return server;
}

/** Add a tool to every Mission's MCP server, run in that Mission's scope. */
export async function registerMissionMcpTool(tool: McpTool<MissionScope>): Promise<void> {
  (await missionMcpServer()).register(tool);
}

/** Whether a call's Authorization names a Mission's token (`orm_…`), rather
 *  than an API key: which of the two MCP servers /api/mcp answers it with. */
export function carriesMissionToken(authorization: string | null): boolean {
  return isMissionToken(readBearer(authorization));
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Answer an MCP POST signed with a Mission's token: refused unless the token
 * names a Mission, then answered in that Mission's scope alone.
 */
export async function answerMissionMcp(request: Request): Promise<Response> {
  const { missionTokens } = await import("@/lib/missions/store");
  const missionId = await missionForToken(readBearer(request.headers.get("authorization")), missionTokens).catch(() => null);
  if (!missionId) {
    return Response.json({ error: "Not a Mission's token." }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "Too large." }, { status: 413 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return Response.json({ error: "Too large." }, { status: 413 });
  return rpcResponse(await (await missionMcpServer()).handleText(text, { missionId }));
}



/**
 * The Mission's MCP server (lib/missions/mcp.ts) for one Mission: its tools
 * (lib/missions/tools.ts) bound to the Mission its token named.
 */

import type { McpServer } from "@/lib/missions/mcp";
import { MISSION_SERVER_INSTRUCTIONS } from "@/lib/missions/prompt";
import { MISSION_MCP_SERVER } from "@/lib/missions/setup";
import { callMissionTool, MISSION_TOOLS, type MissionScope } from "@/lib/missions/tools";
import { missionToolDeps } from "@/lib/missions/tools.deps";


export function missionMcpServer(scope: MissionScope): McpServer {
  const deps = missionToolDeps();
  return {
    name: MISSION_MCP_SERVER,
    version: "1",
    instructions: MISSION_SERVER_INSTRUCTIONS,
    tools: MISSION_TOOLS,
    call: (name, args) => callMissionTool(scope, name, args, deps),
  };
}

/**
 * What a Mission's box gets as it's set up (lib/runtime/session-setup.deps.ts),
 * at its start and at each restore: a new token for its tools, the MCP server
 * they're on in its agent's config, its notes laid out as a file, and the
 * Mission's instructions ahead of its project's. Every other session gets
 * nothing from here.
 */

import type { AgentConfig } from "@/lib/db/agent-config";
import type { EnvironmentSetup } from "@/lib/db/environments";
import { optionalEnv } from "@/lib/env";
import { missionInstructions } from "@/lib/missions/prompt";
import { NOTES_FILE } from "@/lib/missions/rules";

export const MISSION_MCP_SERVER = "outrunner-mission";

export type MissionBoxSetup = { token: string; notes: string; url: string };

/** The Mission's MCP endpoint, as its box reaches the app. */
export function missionMcpUrl(): string | null {
  const base = optionalEnv("RUNTIME_BASE_URL");
  if (!base) return null;
  try {
    return new URL("/api/missions/mcp", base).toString();
  } catch {
    return null;
  }
}

/** The user's own setup with the Mission's MCP server added, under a name of
 *  its own (a server of theirs by that name gives way). */
export function withMissionServer(config: AgentConfig | null, mission: MissionBoxSetup): AgentConfig {
  return {
    archive: config?.archive ?? null,
    items: config?.items ?? [],
    settings: config?.settings ?? {},
    mcpServers: {
      ...(config?.mcpServers ?? {}),
      [MISSION_MCP_SERVER]: {
        type: "http",
        url: mission.url,
        headers: { Authorization: `Bearer ${mission.token}` },
        // In the prompt from the start, not behind Claude's tool search: they
        // are what a Mission does.
        alwaysLoad: true,
      },
    },
  };
}

/** The project's setup with the Mission's instructions ahead of its own, and
 *  its notes as a file in the worktree. */
export function withMissionEnvironment(environment: EnvironmentSetup | null, mission: MissionBoxSetup): EnvironmentSetup {
  return {
    env: environment?.env ?? {},
    files: { ...(environment?.files ?? {}), [NOTES_FILE]: mission.notes || "# Mission notes\n" },
    setup: environment?.setup ?? null,
    run: environment?.run ?? null,
    archive: environment?.archive ?? null,
    ...(environment?.hooks && { hooks: environment.hooks }),
    ...(environment?.generation !== undefined && { generation: environment.generation }),
    instructions: missionInstructions(environment?.instructions ?? null),
  };
}

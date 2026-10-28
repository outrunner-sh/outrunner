/**
 * The Mission's part of its box's setup, wired (lib/missions/setup.ts): read
 * whether the session is a Mission, and if so mint its token and read its
 * notes. Null for any other session.
 */

import { missionMcpUrl, type MissionBoxSetup } from "@/lib/missions/setup";
import { missionTokens, readNotes, sessionById } from "@/lib/missions/store";
import { mintMissionToken } from "@/lib/missions/token";

export async function missionBoxSetup(workspaceId: string): Promise<MissionBoxSetup | null> {
  const session = await sessionById(workspaceId);
  if (session?.kind !== "mission") return null;
  const url = missionMcpUrl();
  if (!url) {
    console.error(`Mission ${workspaceId}: RUNTIME_BASE_URL isn't set, so its box can't reach its tools`);
    return null;
  }
  const [token, notes] = await Promise.all([mintMissionToken(workspaceId, missionTokens), readNotes(workspaceId)]);
  return { token, notes: notes.body, url };
}

/**
 * The Mission's part of its box's setup, wired (lib/missions/setup.ts): read
 * whether the session is a Mission, and if so mint its token and read its
 * notes. Null for any other session.
 */

import { missionMcpUrl, type MissionBoxSetup } from "@/lib/missions/setup";
import { missionBinding } from "@/lib/missions/slack-store";
import { missionTokens, readNotes, sessionById } from "@/lib/missions/store";
import { mintMissionToken } from "@/lib/missions/token";

export async function missionBoxSetup(workspaceId: string): Promise<MissionBoxSetup | null> {
  // On every session's setup path: a hiccup reading whether it's a Mission
  // mustn't fail an ordinary session's setup. Once it's known to be one, a
  // failure is the Mission's, and said.
  const session = await sessionById(workspaceId).catch((error: unknown) => {
    console.error(`Session ${workspaceId}: couldn't tell whether it's a Mission`, error);
    return null;
  });
  if (session?.kind !== "mission") return null;
  const url = missionMcpUrl();
  if (!url) {
    console.error(`Mission ${workspaceId}: RUNTIME_BASE_URL isn't set, so its box can't reach its tools`);
    return null;
  }
  const [token, notes, binding] = await Promise.all([
    mintMissionToken(workspaceId, missionTokens),
    readNotes(workspaceId),
    // Not knowing whether it's on call mustn't fail its setup: it hears it
    // was bound through its outbox too.
    missionBinding(workspaceId).catch(() => null),
  ]);
  return { token, notes: notes.body, url, onCall: binding !== null };
}

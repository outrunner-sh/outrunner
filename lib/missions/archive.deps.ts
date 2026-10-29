/**
 * Archiving a Runner with its Ships, wired (lib/missions/archive.ts): its
 * Ships from the database, and each archived through the lifecycle route,
 * as the owner whose request this is (POST /api/missions/[id]/archive).
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import type { MissionArchiveDeps } from "@/lib/missions/archive";
import { dropQueuedMessages, runnersOf } from "@/lib/missions/store";
import type { Workspace } from "@/lib/runtime/types";
import { asBrowser } from "@/lib/slack/research";

/** Archive a session as its owner would; one asleep is woken first, as the
 *  lifecycle archives only a session that's up. Why not, or null. */
async function archiveSession(session: Workspace): Promise<string | null> {
  const params = { params: Promise.resolve({ id: session.id }) };
  const lifecycle = async (action: string): Promise<string | null> => {
    const response = await lifecyclePOST(asBrowser(`/api/workspaces/${session.id}/lifecycle`, { action }), params);
    if (response.ok) return null;
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error.replace(/\.$/, "") : `it answered ${response.status}`;
  };
  if (session.status === "suspended") {
    const why = await lifecycle("resume");
    if (why) return why;
  }
  return lifecycle("archive");
}

export function missionArchiveDeps(): MissionArchiveDeps {
  return { runners: runnersOf, dropQueued: dropQueuedMessages, archive: archiveSession };
}

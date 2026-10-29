/**
 * Archiving a Runner with its Ships, wired (lib/missions/archive.ts): its
 * Ships and their queued messages from the database, and each archived
 * through the lifecycle route, as the owner whose request this is
 * (POST /api/missions/[id]/archive). Which computers can archive is
 * archive.ts's to say, before any of this is asked.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import type { ArchivedWithNote, MissionArchiveDeps } from "@/lib/missions/archive";
import { returnQueuedMessages, runnersOf, sessionById, takeQueuedMessages } from "@/lib/missions/store";
import type { Workspace } from "@/lib/runtime/types";
import { asBrowser } from "@/lib/slack/research";

/** Archive a session as its owner would, asleep or not (the lifecycle's
 *  archive brings its box back itself): why not, or null, or the note said
 *  when it was archived without its files. */
async function archiveSession(session: Workspace): Promise<string | ArchivedWithNote | null> {
  const params = { params: Promise.resolve({ id: session.id }) };
  const response = await lifecyclePOST(asBrowser(`/api/workspaces/${session.id}/lifecycle`, { action: "archive" }), params);
  const body = (await response.json().catch(() => null)) as { error?: unknown; note?: unknown } | null;
  if (response.ok) return typeof body?.note === "string" ? { note: body.note } : null;
  return typeof body?.error === "string" ? body.error.replace(/\.$/, "") : `it answered ${response.status}`;
}

export function missionArchiveDeps(): MissionArchiveDeps {
  return {
    runners: runnersOf,
    session: sessionById,
    takeQueued: takeQueuedMessages,
    returnQueued: returnQueuedMessages,
    archive: archiveSession,
    now: Date.now,
  };
}

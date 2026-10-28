/**
 * The Mission tools' real wiring (lib/missions/tools.ts): the database with
 * the service role, the boxes reached by the server, and anything that
 * changes a session done through its own routes as its owner.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { getEnvironment } from "@/lib/db/environments";
import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import { boxSummary, boxWorking, writeBoxFile } from "@/lib/missions/box";
import { NOTES_FILE } from "@/lib/missions/rules";
import { runnerPullRequests } from "@/lib/missions/pulls";
import { startRunner } from "@/lib/missions/spawn";
import { sendToRunner } from "@/lib/missions/watch.deps";
import {
  lastRecordedResponse,
  queueMessage,
  queuedCounts,
  readNotes,
  runnersOf,
  sessionById,
  writeNotes,
} from "@/lib/missions/store";
import type { MissionToolDeps } from "@/lib/missions/tools";
import { asBrowser } from "@/lib/slack/research";
import { allows } from "@/lib/orgs/access";
import { actAsUser } from "@/lib/supabase/acting-user";

/** Archive a session as its owner would; one asleep is woken first, as the
 *  lifecycle archives only a session that's up. */
async function archiveAsOwner(ownerId: string, workspaceId: string, status: string): Promise<boolean> {
  return actAsUser(ownerId, async () => {
    const params = { params: Promise.resolve({ id: workspaceId }) };
    const lifecycle = (action: string) => lifecyclePOST(asBrowser(`/api/workspaces/${workspaceId}/lifecycle`, { action }), params);
    if (status === "suspended" && !(await lifecycle("resume")).ok) return false;
    return (await lifecycle("archive")).ok;
  }).catch(() => false);
}

export function missionToolDeps(): MissionToolDeps {
  return {
    access: async (mission) => {
      const level = mission.environmentId
        ? await environmentLevel(mission.ownerId, mission.environmentId)
        : await projectLevel(mission.ownerId, mission.projectId);
      return allows(level, "read") ? null : "The Mission's owner can no longer read its project, so its tools are off.";
    },
    environmentReady: async (mission) => {
      if (!mission.environmentId) return null;
      const environment = await getEnvironment(mission.ownerId, mission.environmentId);
      if (!environment) return "the Mission's project is gone or archived.";
      if (environment.repos.length === 0) return "the Mission's project has no repositories.";
      return null;
    },
    session: sessionById,
    runners: runnersOf,
    working: boxWorking,
    latestResponse: async (session) => (await boxSummary(session))?.lastAssistantMessage ?? (await lastRecordedResponse(session.id)),
    pullRequests: runnerPullRequests,
    startRunner,
    // Its turn is watched, so the Mission hears when it ends.
    send: sendToRunner,
    queue: queueMessage,
    queued: queuedCounts,
    archive: (runner) => archiveAsOwner(runner.ownerId, runner.id, runner.status),
    // Read, and laid on the Mission's box where its file is missing (a box
    // restored from archive has a fresh worktree): never over a file there,
    // which may hold edits not saved yet.
    readNotes: async (missionId) => {
      const notes = await readNotes(missionId);
      const mission = notes.body ? await sessionById(missionId) : null;
      if (mission) await writeBoxFile(mission, NOTES_FILE, notes.body, { ifMissing: true }).catch(() => false);
      return notes;
    },
    // Saved, then laid on the Mission's box too, so the file it reads is what
    // it saved; a box that's down gets them at its next setup.
    writeNotes: async (missionId, body) => {
      await writeNotes(missionId, body);
      const mission = await sessionById(missionId);
      if (mission) {
        await writeBoxFile(mission, NOTES_FILE, body).catch((error: unknown) =>
          console.warn(`Mission ${missionId}: notes saved, but not written to its box`, error),
        );
      }
    },
  };
}

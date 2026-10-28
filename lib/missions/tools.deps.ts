/**
 * The Mission tools' real wiring (lib/missions/tools.ts): the database with
 * the service role, the boxes reached by the server, and anything that
 * changes a session done through its own routes as its owner.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { getEnvironment } from "@/lib/db/environments";
import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import { boxSummary, boxWorking } from "@/lib/missions/box";
import { runnerPullRequests } from "@/lib/missions/pulls";
import { startRunner } from "@/lib/missions/spawn";
import {
  queueMessage,
  queuedCounts,
  readNotes,
  runnersOf,
  sessionById,
  writeNotes,
} from "@/lib/missions/store";
import type { MissionToolDeps } from "@/lib/missions/tools";
import { asBrowser, wakeAndSend } from "@/lib/slack/research";
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
    latestResponse: async (session) => (await boxSummary(session))?.lastAssistantMessage ?? null,
    pullRequests: runnerPullRequests,
    startRunner,
    send: (runner, content) => wakeAndSend(runner.ownerId, runner.id, content).catch(() => false),
    queue: queueMessage,
    queued: queuedCounts,
    archive: (runner) => archiveAsOwner(runner.ownerId, runner.id, runner.status),
    readNotes,
    writeNotes,
  };
}

/**
 * The Mission tools' real wiring (lib/missions/tools.ts): the database with
 * the service role, the boxes reached by the server, and anything that
 * changes a session done through its own routes as its owner.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { getEnvironment } from "@/lib/db/environments";
import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import { boxSummary, sessionWorking, writeBoxFile } from "@/lib/missions/box";
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
import { personLabel } from "@/lib/audit/labels";
import { recordAudit } from "@/lib/audit/record";
import { getInstallation } from "@/lib/db/slack-agent";
import {
  latestRequest,
  linkSlackShip,
  missionBinding,
  missionThread,
  releaseSlackShip,
  requestByKey,
  reserveSpawn,
  saveAskOnce,
  shipLedger,
  threadById,
  type MissionChannel,
} from "@/lib/missions/slack-store";
import { queuePost } from "@/lib/missions/slack-outbox.deps";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { askBlocks } from "@/lib/missions/slack-text";
import type { MissionSlackDeps } from "@/lib/missions/slack-tools";
import { userNames } from "@/lib/slack/web";
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

async function botToken(binding: MissionChannel): Promise<string> {
  const install = await getInstallation(binding.teamId);
  if (!install) throw new Error(`Outrunner isn't installed in Slack workspace ${binding.teamId} any more`);
  return install.botToken;
}

/** The Slack tools' wiring: the bound channel, the request and Ship ledger
 *  (lib/missions/slack-store.ts), and the post queue (slack-outbox.deps.ts). */
function missionSlackDeps(): MissionSlackDeps {
  return {
    binding: missionBinding,
    thread: missionThread,
    threadById,
    request: requestByKey,
    latestRequest,
    canRead: async (userId, mission) => allows(await missionLevel(userId, mission), "read"),
    queue: queuePost,
    saveAsk: saveAskOnce,
    askBlocks: (askId, question, options) => askBlocks(askId, question, options),
    reserveSpawn,
    linkShip: linkSlackShip,
    releaseShip: releaseSlackShip,
    ledger: shipLedger,
    auditShip: async (mission, binding, request, runnerId) => {
      const requester = request?.requestedBy ?? null;
      await recordAudit({
        orgId: binding.orgId,
        actor: requester ? { id: requester, githubLogin: "", name: await personLabel(requester), email: null } : "system",
        action: "mission.slack_ship_started",
        resource: { type: "mission", id: mission.id, label: mission.title ?? mission.branch },
        details: {
          runner_id: runnerId,
          slack_team_id: binding.teamId,
          slack_channel_id: binding.channelId,
          ...(request && { request_id: request.requestKey, requested_by: request.requestedBy, requested_by_slack: request.requestedBySlack }),
          runs_as: mission.ownerId,
        },
      });
    },
    requesterName: async (request, thread) => {
      const binding = await missionBinding(request.missionId);
      const slackUser = request.requestedBySlack;
      const name = binding && slackUser ? ((await userNames(await botToken(binding), [slackUser])).get(slackUser) ?? slackUser) : "someone";
      return { name, permalink: thread?.permalink ?? null };
    },
  };
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
    working: sessionWorking,
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
    slack: missionSlackDeps(),
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

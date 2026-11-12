/**
 * A Mission's automation run, wired (lib/missions/automation-target.ts): the
 * Mission and its binding, its owner's delegation and access, the filter on
 * the org's own key for Outrunner's models (as the Slack agent's watch
 * classifier is: no tools), the message claims, and the request.
 */

import type { PendingRun } from "@/lib/automations/runs";
import { settleRun } from "@/lib/db/automation-runs";
import { delegationApproved } from "@/lib/db/automations";
import { watchModelKey } from "@/lib/db/slack-agent";
import { type MissionRunDeps, startMissionRun } from "@/lib/missions/automation-target";
import { makeRequest } from "@/lib/missions/requests.deps";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { claimSlackMessage, missionBinding } from "@/lib/missions/slack-store";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import { oneShot } from "@/lib/slack/agent-model";

export function missionRunDeps(): MissionRunDeps {
  return {
    mission: sessionById,
    binding: missionBinding,
    delegationApproved: (automationId, mission) => delegationApproved(automationId, { id: mission.id, ownerId: mission.ownerId }),
    ownerCanRead: async (mission) => allows(await missionLevel(mission.ownerId, mission), "read"),
    filter: async (orgId, system, user) => oneShot(await watchModelKey(orgId), system, user),
    claimMessage: (input) => claimSlackMessage({ ...input, source: "slack_watch" }),
    createRequest: makeRequest,
    settleRun: (runId, outcome) =>
      settleRun(runId, { status: outcome.status, reason: outcome.reason, ...(outcome.requestKey && { missionRequestKey: outcome.requestKey }) }),
  };
}

export async function runForMission(run: PendingRun): Promise<void> {
  await startMissionRun(run, missionRunDeps());
}

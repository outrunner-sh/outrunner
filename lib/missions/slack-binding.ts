/**
 * Putting a Mission on call in a Slack channel and taking it off, wired: the
 * same whether it's done in Slack (`be on call here for <project>`,
 * lib/missions/slack-route.ts) or from the Mission's header in the app
 * (app/api/missions/[id]/slack). Each tells the Mission through its outbox
 * (a `slack_channel` event, which carries its on-call instructions to a box
 * already up), and goes in the org's audit log. Going on call also posts the
 * Mission's intro in the channel. Whoever calls has checked the person may
 * (write on the Mission's project).
 */

import { personLabel } from "@/lib/audit/labels";
import { recordAudit } from "@/lib/audit/record";
import { getInstallation } from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import { eventKey } from "@/lib/missions/events";
import { missionBinding, type MissionChannel, openAsks, threadById, unbindChannel } from "@/lib/missions/slack-store";
import { cancelPending } from "@/lib/missions/requests.deps";
import { takeMissionOffCall } from "@/lib/missions/slack-offcall";
import { type CardEnd, introText } from "@/lib/missions/slack-text";
import { recordMissionEvent } from "@/lib/missions/watch.deps";
import type { Workspace } from "@/lib/runtime/types";
import { channelName, postMessage, updateMessage } from "@/lib/slack/web";

export function missionUrl(missionId: string): string | null {
  const base = optionalEnv("RUNTIME_BASE_URL");
  try {
    return base ? new URL(`/workspaces/${missionId}`, base).toString() : null;
  } catch {
    return null;
  }
}

async function audit(
  action: "mission.slack_bound" | "mission.slack_unbound",
  binding: MissionChannel,
  mission: Workspace,
  userId: string,
): Promise<void> {
  await recordAudit({
    orgId: binding.orgId,
    actor: { id: userId, githubLogin: "", name: await personLabel(userId), email: null },
    action,
    resource: { type: "mission", id: mission.id, label: mission.title ?? mission.branch },
    details: { slack_team_id: binding.teamId, slack_channel_id: binding.channelId, project_id: mission.environmentId ?? mission.projectId },
  });
}

/** The Mission is on call in `binding`'s channel now: it's told, the channel
 *  hears its intro, and the org's log has it. Each best effort: the binding
 *  stands whatever fails here. */
export async function announceBinding(binding: MissionChannel, mission: Workspace, project: string, userId: string): Promise<void> {
  const install = await getInstallation(binding.teamId).catch(() => null);
  const name = install ? await channelName(install.botToken, binding.channelId) : null;
  await recordMissionEvent({
    missionId: mission.id,
    runnerId: null,
    kind: "slack_channel",
    payload: { slack: { channel: binding.channelId, bound: true, channelName: name } },
    key: eventKey.slackChannel(mission.id, true, new Date().toISOString()),
  }).catch((error: unknown) => console.error(`Mission ${mission.id}: couldn't tell it it's on call`, error));
  if (install) {
    await postMessage(install.botToken, {
      channel: binding.channelId,
      text: introText({ mission: mission.title ?? "Mission", project, url: missionUrl(mission.id) }),
    }).catch((error: unknown) => console.error(`Mission ${mission.id}: couldn't post its intro`, error));
  }
  await audit("mission.slack_bound", binding, mission, userId);
}

/** Take the Mission off call (lib/missions/slack-offcall.ts): its open
 *  question cards closed, it's told, and the org's log has it. False when it
 *  wasn't on call. */
export async function takeOffCall(mission: Workspace, userId: string, why: CardEnd = "off_call"): Promise<boolean> {
  return takeMissionOffCall(mission, userId, why, {
    binding: missionBinding,
    openAsks,
    thread: threadById,
    update: async (binding, ts, text, blocks) => {
      const install = await getInstallation(binding.teamId);
      if (!install) throw new Error(`Outrunner isn't installed in Slack workspace ${binding.teamId} any more`);
      await updateMessage(install.botToken, { channel: binding.channelId, ts, text, blocks });
    },
    unbind: unbindChannel,
    dropPending: (missionId, binding, why) => cancelPending(missionId, binding.revision, why === "archived" ? "the Mission was archived" : "the Mission went off call"),
    tell: async (m, binding) => {
      await recordMissionEvent({
        missionId: m.id,
        runnerId: null,
        kind: "slack_channel",
        payload: { slack: { channel: binding.channelId, bound: false } },
        key: eventKey.slackChannel(m.id, false, new Date().toISOString()),
      });
    },
    audit: (m, binding, id) => audit("mission.slack_unbound", binding, m, id),
    log: (message, error) => console.error(message, error),
  });
}

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
import { cancelPending } from "@/lib/missions/requests.deps";
import { eventKey } from "@/lib/missions/events";
import { missionBinding, type MissionChannel, openAsks, threadById, unbindChannel } from "@/lib/missions/slack-store";
import { type CardEnd, cardEndText, closedBlocks, introText } from "@/lib/missions/slack-text";
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

/** Every open question card of the Mission says nothing is waiting on it
 *  now. Best effort, one at a time: a card that can't be edited is still
 *  refused when clicked (lib/missions/slack-ask.ts). How many were closed. */
export async function closeOpenCards(missionId: string, binding: MissionChannel, why: CardEnd): Promise<number> {
  const install = await getInstallation(binding.teamId).catch(() => null);
  if (!install) return 0;
  let closed = 0;
  for (const ask of await openAsks(missionId).catch(() => [])) {
    const thread = await threadById(ask.threadId).catch(() => null);
    if (!ask.messageTs || !thread || thread.channelId !== binding.channelId) continue;
    try {
      await updateMessage(install.botToken, { channel: binding.channelId, ts: ask.messageTs, text: `${ask.question}: ${cardEndText(why)}`, blocks: closedBlocks(ask.question, why) });
      closed++;
    } catch (error) {
      console.error(`Mission ${missionId}: couldn't close its question card ${ask.id}`, error);
    }
  }
  return closed;
}

/** Take the Mission off call: it's told, its open question cards are closed,
 *  and the org's log has it. Work it already started goes on, with its owner
 *  (docs/missions.md); requests of this binding start nothing more, as their
 *  binding is gone (lib/missions/slack-tools.ts). False when it wasn't on
 *  call. */
export async function takeOffCall(mission: Workspace, userId: string, why: CardEnd = "off_call"): Promise<boolean> {
  const binding = await missionBinding(mission.id);
  if (!binding) return false;
  // Closed first: once the row is gone, a card's click can't tell its binding.
  await closeOpenCards(mission.id, binding, why).catch((error: unknown) => console.error(`Mission ${mission.id}: couldn't close its cards`, error));
  if (!(await unbindChannel(mission.id))) return false;
  // Requests with no Ship yet are dropped; Ships started go on (their owner's).
  await cancelPending(mission.id, why === "archived" ? "the Mission was archived" : "the Mission went off call").catch((error: unknown) =>
    console.error(`Mission ${mission.id}: couldn't cancel its pending requests`, error),
  );
  await recordMissionEvent({
    missionId: mission.id,
    runnerId: null,
    kind: "slack_channel",
    payload: { slack: { channel: binding.channelId, bound: false } },
    key: eventKey.slackChannel(mission.id, false, new Date().toISOString()),
  }).catch((error: unknown) => console.error(`Mission ${mission.id}: couldn't tell it it's off call`, error));
  await audit("mission.slack_unbound", binding, mission, userId);
  return true;
}

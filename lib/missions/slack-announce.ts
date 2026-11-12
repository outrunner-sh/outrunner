/**
 * A Ship's news told in the Slack thread it was started for (docs/missions.md,
 * "On call in Slack"), by the system rather than the Mission: its pull
 * request ready, merged or closed, as a compact card (the Slack agent's own
 * pull request line, lib/slack/announce-pull-request.ts). Posted once each,
 * as its event is recorded once (lib/missions/watch.deps.ts). Not in a muted
 * thread, nor once the Mission is off call in that thread's channel. And a
 * Mission whose `ask_user` waits on its owner says so in its latest thread.
 */

import type { MissionEventKind, MissionEventPayload } from "@/lib/missions/events";
import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { pullRequestCard } from "@/lib/missions/slack-text";

export type AnnounceDeps = {
  shipThread(runnerId: string): Promise<MissionThread | null>;
  binding(missionId: string): Promise<MissionChannel | null>;
  latestThread(binding: MissionChannel): Promise<MissionThread | null>;
  post(binding: MissionChannel, threadTs: string, text: string): Promise<void>;
};

/** The thread, if the system may still post in it. */
async function postable(
  thread: MissionThread | null,
  deps: AnnounceDeps,
  known?: MissionChannel,
): Promise<{ binding: MissionChannel; thread: MissionThread } | null> {
  if (!thread || thread.muted) return null;
  const binding = known ?? (await deps.binding(thread.missionId));
  if (!binding || binding.teamId !== thread.teamId || binding.channelId !== thread.channelId) return null;
  return { binding, thread };
}

/** A Ship's event, told in its thread if it's one Slack hears; true when it
 *  was posted. */
export async function announceShipEvent(
  event: { runnerId: string | null; kind: MissionEventKind; payload: MissionEventPayload },
  deps: AnnounceDeps,
): Promise<boolean> {
  if (!event.runnerId || !event.payload.pr) return false;
  if (event.kind !== "ready" && event.kind !== "merged" && event.kind !== "closed") return false;
  const where = await postable(await deps.shipThread(event.runnerId), deps);
  if (!where) return false;
  await deps.post(where.binding, where.thread.threadTs, pullRequestCard(event.kind, event.payload.pr, event.payload.runner ?? "Ship"));
  return true;
}

/** The Mission waits on its owner's decision (its ask_user card): its
 *  latest thread hears so, with where to answer. True when it was posted. */
export async function announceWaiting(missionId: string, url: string | null, deps: AnnounceDeps): Promise<boolean> {
  const binding = await deps.binding(missionId);
  if (!binding) return false;
  const where = await postable(await deps.latestThread(binding), deps, binding);
  if (!where) return false;
  await deps.post(
    where.binding,
    where.thread.threadTs,
    `:raised_hand: The Mission is waiting on a decision from its owner before it goes on${url ? `: <${url}|answer in Outrunner>` : "."}`,
  );
  return true;
}

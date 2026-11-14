/**
 * A Mission going off call, the parts with no network: its open question
 * cards closed, the binding ended, the Mission told, the org's log written.
 * The wiring is lib/missions/slack-binding.ts (takeOffCall).
 *
 * The order is the point: cards close first (once the binding row is gone a
 * click can't tell what it was under), the binding ends before anything
 * pending is dropped (an in-flight Ship start or post is refused once its
 * revision is gone, lib/missions/slack-tools.ts recheckStart, so nothing new
 * can begin under the ended binding while pending work is dropped), and
 * the Mission hears of it last.
 */

import type { MissionAsk, MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { type CardEnd, cardEndText, closedBlocks } from "@/lib/missions/slack-text";
import type { Workspace } from "@/lib/runtime/types";

export type OffCallDeps = {
  binding(missionId: string): Promise<MissionChannel | null>;
  /** The Mission's question cards on screen and not answered. */
  openAsks(missionId: string): Promise<MissionAsk[]>;
  thread(id: string): Promise<MissionThread | null>;
  /** Edit a card; rejects when it can't. */
  update(binding: MissionChannel, ts: string, text: string, blocks: Record<string, unknown>[]): Promise<void>;
  /** End the binding; true when it was on. */
  unbind(missionId: string): Promise<boolean>;
  /** Drop what the ended binding left pending (requests with no Ship). */
  dropPending?(missionId: string, binding: MissionChannel, why: CardEnd): Promise<unknown>;
  /** Tell the Mission it's off call. */
  tell(mission: Workspace, binding: MissionChannel): Promise<void>;
  audit(mission: Workspace, binding: MissionChannel, userId: string): Promise<void>;
  log(message: string, error: unknown): void;
};

/** Every open question card of the Mission says nothing is waiting on it.
 *  Best effort, one at a time: a card that can't be edited is still refused
 *  when clicked (lib/missions/slack-ask.ts). How many were closed. */
export async function closeOpenCards(missionId: string, binding: MissionChannel, why: CardEnd, deps: OffCallDeps): Promise<number> {
  let closed = 0;
  for (const ask of await deps.openAsks(missionId)) {
    const thread = await deps.thread(ask.threadId).catch(() => null);
    if (!ask.messageTs || !thread || thread.channelId !== binding.channelId) continue;
    try {
      await deps.update(binding, ask.messageTs, `${ask.question}: ${cardEndText(why)}`, closedBlocks(ask.question, why));
      closed++;
    } catch (error) {
      deps.log(`Mission ${missionId}: couldn't close its question card ${ask.id}`, error);
    }
  }
  return closed;
}

/** Take the Mission off call. Work it already started goes on, with its
 *  owner (docs/missions.md). False when it wasn't on call. */
export async function takeMissionOffCall(mission: Workspace, userId: string, why: CardEnd, deps: OffCallDeps): Promise<boolean> {
  const binding = await deps.binding(mission.id);
  if (!binding) return false;
  await closeOpenCards(mission.id, binding, why, deps).catch((error: unknown) => deps.log(`Mission ${mission.id}: couldn't close its cards`, error));
  if (!(await deps.unbind(mission.id))) return false;
  await deps.dropPending?.(mission.id, binding, why).catch((error: unknown) => deps.log(`Mission ${mission.id}: couldn't drop its pending requests`, error));
  await deps.tell(mission, binding).catch((error: unknown) => deps.log(`Mission ${mission.id}: couldn't tell it it's off call`, error));
  await deps.audit(mission, binding, userId);
  return true;
}

/**
 * Delivering a Mission's events (mission_events) to it, exactly once
 * (20261102200000_missions.sql has the whole of how):
 *
 * - a delivery is claimed under a lease (claim_mission_delivery), so racing
 *   ticks and watches send it once, and a claimer that dies is taken over;
 * - the Mission is woken first, then sent the delivery as one message:
 *   mid-turn it's folded into the turn running, otherwise it starts a new
 *   one (one archived hears nothing more);
 * - the message carries the delivery's id as its key, which the box sends
 *   once (FeatureMessageKeys), so sending it again after a crash between
 *   sending and recording it is no second message;
 * - a send that fails is tried again with backoff, never dropped;
 * - while the Mission is budget-paused (docs/missions.md, "Budgets"), nothing
 *   is claimed: its events are held, never dropped, and go once the pause
 *   lifts (its period rolls over, or its limit is raised).
 */

import { formatDelivery, type MissionEvent } from "@/lib/missions/events";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";

/** A claim's lease: long enough to wake the Mission and send. */
export const DELIVERY_LEASE_SECONDS = 10 * 60;
/** Events wait this long for others arriving with them... */
export const DELIVERY_SETTLE_SECONDS = 3;
/** ...but never longer than this from the first. */
export const DELIVERY_MAX_WAIT_SECONDS = 20;

export type OutboxDeps = {
  claim(missionId: string): Promise<{ deliveryId: string; attempt: number } | null>;
  eventsOf(deliveryId: string): Promise<MissionEvent[]>;
  session(id: string): Promise<Workspace | null>;
  /** Wake the Mission, then send `text` with `key`; throws when it didn't
   *  go. */
  send(mission: Workspace, text: string, key: string): Promise<void>;
  complete(deliveryId: string): Promise<void>;
  fail(deliveryId: string, reason: string): Promise<void>;
  /** The Mission is budget-paused: its events wait. */
  held?(missionId: string): Promise<boolean>;
  log?(message: string, error?: unknown): void;
};

/** A Mission in one of these hears nothing more: its events are dropped.
 *  (One being archived is tried again, as any send that fails: if its
 *  archive fails, it hears them.) */
const PUT_AWAY: readonly WorkspaceStatus[] = ["archived", "destroying", "destroyed"];

export type DeliveryOutcome = "delivered" | "nothing" | "failed" | "dropped" | "held";

/** Deliver the Mission's next batch of events, if one is due. */
export async function deliverMissionEvents(missionId: string, deps: OutboxDeps): Promise<DeliveryOutcome> {
  // Asked before the claim, so a held batch stays as it is, to go whole.
  if (deps.held && (await deps.held(missionId))) return "held";
  const claim = await deps.claim(missionId);
  if (!claim) return "nothing";
  const events = await deps.eventsOf(claim.deliveryId);
  const mission = await deps.session(missionId);
  // A Mission deleted meanwhile has no one to tell: done with, so the outbox
  // empties. So with one archived: its owner put it away with its Ships
  // (lib/missions/archive.ts), and a pull request of theirs merging later
  // mustn't bring it back. One asleep is woken by the send.
  if (!mission || mission.kind !== "mission" || PUT_AWAY.includes(mission.status) || events.length === 0) {
    await deps.complete(claim.deliveryId);
    return "dropped";
  }
  try {
    await deps.send(mission, formatDelivery(events), claim.deliveryId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log?.(`Mission ${missionId}: delivery ${claim.deliveryId} (attempt ${claim.attempt}) didn't go: ${reason}`, error);
    await deps.fail(claim.deliveryId, reason);
    return "failed";
  }
  await deps.complete(claim.deliveryId);
  return "delivered";
}

/** Deliver until nothing more is due now (a delivery that went may leave
 *  events that arrived meanwhile). */
export async function drainMissionEvents(missionId: string, deps: OutboxDeps, max = 5): Promise<number> {
  let delivered = 0;
  for (let i = 0; i < max; i++) {
    const outcome = await deliverMissionEvents(missionId, deps);
    if (outcome === "delivered") delivered++;
    if (outcome === "nothing" || outcome === "failed" || outcome === "held") break;
  }
  return delivered;
}

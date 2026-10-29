/**
 * Delivering a Mission's events (mission_events) to it, exactly once
 * (20261102200000_missions.sql has the whole of how):
 *
 * - a delivery is claimed under a lease (claim_mission_delivery), so racing
 *   ticks and watches send it once, and a claimer that dies is taken over;
 * - the Mission is woken (or restored) first, then sent the delivery as one
 *   message: mid-turn it's folded into the turn running, otherwise it starts
 *   a new one;
 * - the message carries the delivery's id as its key, which the box sends
 *   once (FeatureMessageKeys), so sending it again after a crash between
 *   sending and recording it is no second message;
 * - a send that fails is tried again with backoff, never dropped.
 */

import { formatDelivery, type MissionEvent } from "@/lib/missions/events";
import type { Workspace } from "@/lib/runtime/types";

/** A claim's lease: long enough to restore an archived Mission and send. */
export const DELIVERY_LEASE_SECONDS = 10 * 60;
/** Events wait this long for others arriving with them... */
export const DELIVERY_SETTLE_SECONDS = 3;
/** ...but never longer than this from the first. */
export const DELIVERY_MAX_WAIT_SECONDS = 20;

export type OutboxDeps = {
  claim(missionId: string): Promise<{ deliveryId: string; attempt: number } | null>;
  eventsOf(deliveryId: string): Promise<MissionEvent[]>;
  session(id: string): Promise<Workspace | null>;
  /** Wake or restore the Mission, then send `text` with `key`; throws when
   *  it didn't go. */
  send(mission: Workspace, text: string, key: string): Promise<void>;
  complete(deliveryId: string): Promise<void>;
  fail(deliveryId: string, reason: string): Promise<void>;
  log?(message: string, error?: unknown): void;
};

export type DeliveryOutcome = "delivered" | "nothing" | "failed" | "dropped";

/** Deliver the Mission's next batch of events, if one is due. */
export async function deliverMissionEvents(missionId: string, deps: OutboxDeps): Promise<DeliveryOutcome> {
  const claim = await deps.claim(missionId);
  if (!claim) return "nothing";
  const events = await deps.eventsOf(claim.deliveryId);
  const mission = await deps.session(missionId);
  // A Mission deleted meanwhile has no one to tell: done with, so the outbox
  // empties. One archived or asleep is woken by the send.
  if (!mission || mission.kind !== "mission" || mission.status === "destroyed" || mission.status === "destroying" || events.length === 0) {
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
    if (outcome === "nothing" || outcome === "failed") break;
  }
  return delivered;
}

/**
 * The outbox's real wiring (lib/missions/outbox.ts): the claim functions in
 * the database, and a send that wakes the Mission through its lifecycle
 * route as its owner, then hands the delivery to its box's agent with the
 * delivery's id as the message's key.
 */

import { POST as lifecyclePOST } from "@/app/api/workspaces/[id]/lifecycle/route";
import { reachBox } from "@/lib/missions/box";
import type { MissionEvent, MissionEventPayload } from "@/lib/missions/events";
import {
  DELIVERY_LEASE_SECONDS,
  DELIVERY_MAX_WAIT_SECONDS,
  DELIVERY_SETTLE_SECONDS,
  drainMissionEvents,
  type OutboxDeps,
} from "@/lib/missions/outbox";
import { sessionById } from "@/lib/missions/store";
import { AGENT_FEATURE_MESSAGE_KEYS } from "@/lib/runtime/agent-protocol";
import type { Workspace } from "@/lib/runtime/types";
import { asBrowser } from "@/lib/slack/research";
import { actAsUser } from "@/lib/supabase/acting-user";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** Bring an asleep session's box up, as its owner opening it would; throws
 *  when it can't be. One archived since the outbox looked stays archived: the
 *  send fails, and its next try drops the news (lib/missions/outbox.ts). */
export async function wakeSession(session: Workspace): Promise<Workspace> {
  const action = session.status === "suspended" ? "resume" : null;
  if (action) {
    const response = await actAsUser(session.ownerId, () =>
      lifecyclePOST(asBrowser(`/api/workspaces/${session.id}/lifecycle`, { action }), { params: Promise.resolve({ id: session.id }) }),
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`couldn't ${action} it: ${body?.error ?? response.status}`);
    }
  }
  const now = action ? await sessionById(session.id) : session;
  if (!now || (now.status !== "ready" && now.status !== "idle")) throw new Error(`it is ${now?.status ?? "gone"}`);
  return now;
}

async function sendOnce(mission: Workspace, text: string, key: string): Promise<void> {
  const awake = await wakeSession(mission);
  const reached = await reachBox(awake);
  if (!reached) throw new Error("its box didn't answer");
  const features = (await reached.agent.health(reached.identity).catch(() => null))?.features ?? [];
  if (!features.includes(AGENT_FEATURE_MESSAGE_KEYS)) {
    // An agent from before keys: still sent, but a repeat after a crash on
    // our side would be said twice. Its next box has a newer agent.
    console.warn(`Mission ${mission.id}: its box's agent can't send once per key`);
  }
  await reached.agent.sendMessage(reached.identity, text, { key });
}

export function outboxDeps(): OutboxDeps {
  return {
    claim: async (missionId) => {
      const { data, error } = await db().rpc("claim_mission_delivery", {
        target: missionId,
        lease_seconds: DELIVERY_LEASE_SECONDS,
        settle_seconds: DELIVERY_SETTLE_SECONDS,
        max_wait_seconds: DELIVERY_MAX_WAIT_SECONDS,
      });
      if (error) throw error;
      const row = data?.[0];
      return row ? { deliveryId: row.delivery_id, attempt: row.attempt } : null;
    },
    eventsOf: async (deliveryId) => {
      const { data, error } = await db()
        .from("mission_events")
        .select("id, runner_id, kind, payload, created_at")
        .eq("delivery_id", deliveryId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(
        (row): MissionEvent => ({
          id: row.id,
          runnerId: row.runner_id,
          kind: row.kind,
          payload: (row.payload ?? {}) as MissionEventPayload,
          createdAt: row.created_at,
        }),
      );
    },
    session: sessionById,
    send: sendOnce,
    complete: async (deliveryId) => {
      const { error } = await db().rpc("complete_mission_delivery", { target: deliveryId });
      if (error) throw error;
    },
    fail: async (deliveryId, reason) => {
      const { error } = await db().rpc("fail_mission_delivery", { target: deliveryId, failure: reason });
      if (error) throw error;
    },
    log: (message, error) => console.warn(message, error instanceof Error ? error.message : ""),
  };
}

/** Deliver what's due to the Mission now; never throws. */
export async function deliverNow(missionId: string): Promise<number> {
  return drainMissionEvents(missionId, outboxDeps()).catch((error: unknown) => {
    console.error(`Mission ${missionId}: delivery failed`, error);
    return 0;
  });
}

/** Missions with events waiting, for the tick. */
export async function missionsWithPendingEvents(max = 50): Promise<string[]> {
  const { data, error } = await db().rpc("missions_with_pending_events", { max_missions: max });
  if (error) throw error;
  return (data ?? []).map((r) => r.mission_id);
}

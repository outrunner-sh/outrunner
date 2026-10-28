/**
 * The Runner watch's real wiring (lib/missions/watch.ts): turn_watches and
 * mission_events with the service role, the box looked at by the server, and
 * sends through the session's routes as its owner. Recording an event also
 * sets its delivery going (lib/missions/outbox.deps.ts), a few seconds on, so
 * events that arrive together go together.
 */

import { after } from "next/server";

import { boxSummary, lookAtBox } from "@/lib/missions/box";
import { deliverNow } from "@/lib/missions/outbox.deps";
import { DELIVERY_MAX_WAIT_SECONDS, DELIVERY_SETTLE_SECONDS } from "@/lib/missions/outbox";
import { returnQueuedMessage, sessionById, takeQueuedMessage } from "@/lib/missions/store";
import { checkRunnerWatch, type RecordedEvent, sendNextQueued, type WatchDeps, type WatchRow } from "@/lib/missions/watch";
import type { Json } from "@/lib/supabase/database.types";
import type { Workspace } from "@/lib/runtime/types";
import { watchUntil } from "@/lib/session/turn-watch";
import { wakeAndSend } from "@/lib/slack/research";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** How long the watch right after a send lasts, and how often it looks; the
 *  tick carries on after. */
const WATCH_MS = 10 * 60_000;
const WATCH_EVERY_MS = 10_000;

function db() {
  return createSupabaseAdminClient();
}

/** Run `work` after the response, or now outside a request. */
function later(work: () => Promise<unknown>): void {
  const guarded = () => work().catch((error: unknown) => console.error("Missions: background work failed", error));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

const scheduled = new Set<string>();

/** Deliver the Mission's events once they've settled: a few seconds, so ones
 *  arriving together go as one. The tick catches anything this misses. */
export function scheduleDelivery(missionId: string): void {
  if (scheduled.has(missionId)) return;
  scheduled.add(missionId);
  later(async () => {
    try {
      const until = Date.now() + (DELIVERY_MAX_WAIT_SECONDS + 5) * 1000;
      do {
        await new Promise((resolve) => setTimeout(resolve, (DELIVERY_SETTLE_SECONDS + 1) * 1000));
        if ((await deliverNow(missionId)) > 0 && !(await hasPending(missionId))) return;
      } while (Date.now() < until && (await hasPending(missionId)));
    } finally {
      scheduled.delete(missionId);
    }
  });
}

async function hasPending(missionId: string): Promise<boolean> {
  const { count } = await db()
    .from("mission_events")
    .select("id", { count: "exact", head: true })
    .eq("mission_id", missionId)
    .is("delivered_at", null);
  return (count ?? 0) > 0;
}

/** Record a Runner's event for its Mission, once; true when it's new. */
export async function recordMissionEvent(event: RecordedEvent): Promise<boolean> {
  const { data, error } = await db()
    .from("mission_events")
    .upsert(
      {
        mission_id: event.missionId,
        runner_id: event.runnerId,
        kind: event.kind,
        payload: event.payload as Json,
        idempotency_key: event.key,
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  const fresh = (data?.length ?? 0) > 0;
  if (fresh) scheduleDelivery(event.missionId);
  return fresh;
}

function toRow(row: {
  workspace_id: string;
  sent_at: string;
  baseline_activity: string | null;
  seen_working: boolean;
  quiet_since: string | null;
  quiet_activity: string | null;
  last_message: string | null;
  unreachable_since: string | null;
}): WatchRow {
  return {
    workspaceId: row.workspace_id,
    sentAt: row.sent_at,
    baselineActivity: row.baseline_activity,
    seenWorking: row.seen_working,
    quietSince: row.quiet_since,
    quietActivity: row.quiet_activity,
    lastMessage: row.last_message,
    unreachableSince: row.unreachable_since,
  };
}

async function readWatch(workspaceId: string): Promise<WatchRow | null> {
  const { data, error } = await db().from("turn_watches").select("*").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  return data ? toRow(data) : null;
}

/** Open a watch on the Runner's turn, starting from a send at `sentAt`
 *  (ours) after its box last did something at `baseline` (its). */
export async function openRunnerWatch(runnerId: string, sentAt: Date, baseline: string | null): Promise<void> {
  const { error } = await db()
    .from("turn_watches")
    .upsert(
      {
        workspace_id: runnerId,
        purpose: "runner",
        sent_at: sentAt.toISOString(),
        baseline_activity: baseline,
        seen_working: false,
        quiet_since: null,
        quiet_activity: null,
        unreachable_since: null,
        checked_at: null,
      },
      { onConflict: "workspace_id" },
    );
  if (error) throw error;
}

export function watchDeps(): WatchDeps {
  return {
    session: sessionById,
    look: lookAtBox,
    save: async (row) => {
      const { error } = await db()
        .from("turn_watches")
        .update({
          seen_working: row.seenWorking,
          quiet_since: row.quietSince,
          quiet_activity: row.quietActivity,
          last_message: row.lastMessage?.slice(0, 200000) ?? null,
          unreachable_since: row.unreachableSince,
          checked_at: new Date().toISOString(),
        })
        .eq("workspace_id", row.workspaceId)
        // Only the watch it read: a send since has opened a new one.
        .eq("sent_at", row.sentAt);
      if (error) throw error;
    },
    close: async (workspaceId) => {
      await db().from("turn_watches").delete().eq("workspace_id", workspaceId);
    },
    record: recordMissionEvent,
    takeQueued: takeQueuedMessage,
    returnQueued: returnQueuedMessage,
    sendAndWatch: sendToRunner,
    now: Date.now,
  };
}

/**
 * Send to a Runner as its owner (woken or restored first), and watch the turn
 * it starts. False when it didn't go.
 */
export async function sendToRunner(runner: Workspace, content: string): Promise<boolean> {
  // Its box's clock before the send: what's after it is this turn's.
  const baseline = (await boxSummary(runner).catch(() => null))?.lastActivity ?? null;
  const sentAt = new Date();
  if (!(await wakeAndSend(runner.ownerId, runner.id, content).catch(() => false))) return false;
  await openRunnerWatch(runner.id, sentAt, baseline);
  watchSoon(runner.id);
  return true;
}

/** Look at the Runner's watch every few seconds for a while, from now. */
export function watchSoon(runnerId: string): void {
  later(() =>
    watchUntil(
      async () => {
        const row = await readWatch(runnerId);
        if (!row) return true;
        return (await checkRunnerWatch(row, watchDeps())) !== "waiting";
      },
      { forMs: WATCH_MS, everyMs: WATCH_EVERY_MS },
    ),
  );
}

/** The tick's part: watches not looked at lately. One seen ended is looked
 *  at again within the tick (all together, after one wait) to confirm it,
 *  rather than a tick later. */
export async function checkStaleWatches(limit = 40): Promise<number> {
  const { data, error } = await db()
    .from("turn_watches")
    .select("*")
    .or(`checked_at.is.null,checked_at.lt.${new Date(Date.now() - 60_000).toISOString()}`)
    .order("checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  const deps = watchDeps();
  const check = (row: WatchRow) => checkRunnerWatch(row, deps).catch(() => "waiting" as const);
  const first = await Promise.all((data ?? []).map((row) => check(toRow(row))));
  let ended = first.filter((o) => o !== "waiting").length;
  const toConfirm = (await Promise.all((data ?? []).map((row) => readWatch(row.workspace_id)))).filter(
    (row): row is WatchRow => row !== null && row.quietSince !== null,
  );
  if (toConfirm.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    ended += (await Promise.all(toConfirm.map(check))).filter((o) => o !== "waiting").length;
  }
  return ended;
}

/** The tick's part: Runners with messages queued, not mid-turn and not
 *  watched (a send that failed when their turn ended). */
export async function sendWaitingQueued(limit = 20): Promise<number> {
  const { data, error } = await db().from("mission_queued_messages").select("runner_id").is("sent_at", null).limit(limit * 5);
  if (error) throw error;
  let sent = 0;
  for (const runnerId of [...new Set((data ?? []).map((r) => r.runner_id))].slice(0, limit)) {
    if (await readWatch(runnerId)) continue;
    const runner = await sessionById(runnerId);
    if (!runner || runner.status === "creating" || runner.status === "provisioning" || runner.status === "failed") continue;
    if ((await lookAtBox(runner)).working) continue;
    if (await sendNextQueued(runner, watchDeps())) sent++;
  }
  return sent;
}

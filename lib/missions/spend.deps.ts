/**
 * Mission spend's database side (lib/missions/spend.ts, docs/mission-spend.md):
 * recording a family's model calls, reading a period's spend, and the policy
 * reservations. Service role throughout: callers check who may first.
 */

import type { Interval } from "@/lib/billing/hours";
import { allRows } from "@/lib/billing/metering-store";
import { computeRate, costBasisExtension } from "@/lib/missions/cost-basis";
import {
  callsFromEvents,
  classifierCall,
  gapCalls,
  gapLikePattern,
  missionOf,
  type MissionSpend,
  type OpenRouterAnswer,
  type SpendPeriodKind,
  spendPeriod,
  summarizeSpend,
  UNREAD_GRACE_MS,
  type UsageCall,
  writeCallsIsolating,
} from "@/lib/missions/spend";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import type { WorkspaceStatus } from "@/lib/runtime/types";
import { SETTING_UP } from "@/lib/session/provisioning";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** Record calls, each once (record_mission_usage): new ones, and a known one
 *  read again with more tokens or a better-known cost. A call refused for its
 *  data doesn't hold back the others (writeCallsIsolating). How many were
 *  new. */
export async function recordCalls(calls: readonly UsageCall[]): Promise<number> {
  return writeCallsIsolating(calls, writeCalls);
}

/** One record_mission_usage statement. */
async function writeCalls(calls: readonly UsageCall[]): Promise<number> {
  const rows = calls.map((c) => ({
    usage_ref: c.usageRef,
    mission_id: c.missionId,
    workspace_id: c.workspaceId,
    source: c.source,
    occurred_at: c.occurredAt,
    model: c.model,
    input_tokens: c.input_tokens,
    output_tokens: c.output_tokens,
    cache_creation_input_tokens: c.cache_creation_input_tokens,
    cache_read_input_tokens: c.cache_read_input_tokens,
    coverage: c.coverage,
    usd_reported: c.usdReported,
    usd_estimated: c.usdEstimated,
    cost_basis: c.costBasis,
  }));
  const { data, error } = await db().rpc("record_mission_usage", { calls: rows as unknown as Json });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Record the model calls in what readSession just read of a session's log,
 * when the session is a Mission's or a Ship's; nothing for any other. Called
 * before the read's cursor moves on, so a failure here leaves the events to
 * be read (and recorded) again, and recording twice is harmless.
 */
export async function recordSessionCalls(
  workspace: { id: string; kind?: string | null; parentMissionId?: string | null },
  events: readonly AgentEvent[],
): Promise<number> {
  const missionId = missionOf(workspace);
  if (!missionId || events.length === 0) return 0;
  const calls = callsFromEvents({ workspaceId: workspace.id, missionId }, events, costBasisExtension());
  if (!calls.length) return 0;
  try {
    return await recordCalls(calls);
  } catch (error) {
    // Deployed before its migration: reading the session matters more than
    // counting it, so its turns are still watched; said once a read.
    if (isMissingFunction(error)) {
      console.error("Mission spend: record_mission_usage isn't in the database yet (run pnpm db:migrate); calls not counted.");
      return 0;
    }
    throw error;
  }
}

/**
 * A family session's turn was cut off unread (lib/session/watch.ts settle: its
 * box went down, or it was paused or archived, mid-turn): mark the stretch
 * from its last read to when its box stopped as unknown (gapCalls). Never
 * throws: the session's own state is settled already, and a failure here is
 * logged.
 */
export async function recordSessionGap(
  workspace: { id: string; kind?: string | null; parentMissionId?: string | null },
  lastRead: { box: string | null; cursor: number; at: string | null },
): Promise<void> {
  const missionId = missionOf(workspace);
  if (!missionId) return;
  try {
    const until = (lastRead.box && (await boxStoppedAt(lastRead.box))) || new Date();
    await recordCalls(gapCalls({ workspaceId: workspace.id, missionId }, lastRead, until));
  } catch (error) {
    if (!isMissingFunction(error)) console.error(`Mission spend: couldn't mark ${workspace.id}'s unread stretch`, error);
  }
}

/** When a box last ran, as metering saw it: its latest interval's end, or
 *  last sighting while open. Null for a box not metered (a user's own). */
async function boxStoppedAt(sandboxId: string): Promise<Date | null> {
  const { data, error } = await db()
    .from("compute_intervals")
    .select("ended_at, last_seen_at")
    .eq("sandbox_id", sandboxId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? new Date(data.ended_at ?? data.last_seen_at) : null;
}

/**
 * A read of a family session went on from where a cut-off one stopped, on the
 * same box (its log still there): the stretch it marked unknown is being read
 * after all, so its gap entries go. A read cut off again marks a new gap from
 * its own cursor. Never throws: a gap left is only too cautious.
 */
export async function closeSessionGap(
  workspace: { id: string; kind?: string | null; parentMissionId?: string | null },
  box: string,
  cursor: number,
): Promise<void> {
  const missionId = missionOf(workspace);
  if (!missionId) return;
  const pattern = gapLikePattern(workspace.id, box, cursor);
  const { error } = await db()
    .from("mission_usage")
    .delete()
    .eq("workspace_id", workspace.id)
    .eq("mission_id", missionId)
    .eq("coverage", "unavailable")
    .like("usage_ref", pattern);
  if (error && !isMissingFunction(error)) console.error(`Mission spend: couldn't close ${workspace.id}'s gap`, error);
}

/** PostgREST's "no such function" (PGRST202), or Postgres' (42883). */
function isMissingFunction(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "42883";
}

/** Record a classifier call made for a Mission, from OpenRouter's answer. */
export async function recordClassifierCall(missionId: string, answer: OpenRouterAnswer): Promise<void> {
  const call = classifierCall(missionId, answer, costBasisExtension());
  if (!call) {
    console.error(`Mission spend: a classifier call for ${missionId} had no generation id; it can't be counted.`);
    return;
  }
  await recordCalls([call]);
}

/** The Mission and its Ships, archived ones included: what they spent stays
 *  spent. */
async function familyIds(missionId: string): Promise<string[]> {
  const { data, error } = await db().from("workspaces").select("id").eq("parent_mission_id", missionId);
  if (error) throw error;
  return [missionId, ...(data ?? []).map((w) => w.id)];
}

/** The family's boxes' compute intervals that may fall in the period. */
async function familyIntervals(ids: string[], period: { start: Date; end: Date }): Promise<Interval[]> {
  const { data: computers, error } = await db().from("runtime_computers").select("id").in("workspace_id", ids);
  if (error) throw error;
  const computerIds = (computers ?? []).map((c) => c.id);
  if (!computerIds.length) return [];
  const rows = await allRows((from, to) =>
    db()
      .from("compute_intervals")
      .select("id, sandbox_id, cpu, started_at, last_seen_at, ended_at")
      .in("computer_id", computerIds)
      .lt("started_at", period.end.toISOString())
      .or(`ended_at.is.null,ended_at.gt.${period.start.toISOString()}`)
      .order("id")
      .range(from, to),
  );
  return rows.map((r) => ({
    sandboxId: r.sandbox_id,
    cpu: Number(r.cpu),
    startedAt: new Date(r.started_at),
    lastSeenAt: new Date(r.last_seen_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
  }));
}

/** Sessions that never ran an agent: still being set up, or failed (only
 *  setup fails a session). */
const NEVER_RAN: readonly WorkspaceStatus[] = [...SETTING_UP, "failed"];

/** Family sessions brought up in the period (made, woken, restored: their
 *  last_active_at) whose log hasn't been read since, for longer than the
 *  tick takes to read it. One that never ran an agent made no calls. */
async function unreadSessions(ids: string[], period: { start: Date; end: Date }, now: Date): Promise<number> {
  const { data: sessions, error } = await db()
    .from("workspaces")
    .select("id, last_active_at")
    .in("id", ids)
    .not("status", "in", `(${NEVER_RAN.join(",")})`)
    .gte("last_active_at", period.start.toISOString())
    .lt("last_active_at", new Date(Math.min(period.end.getTime(), now.getTime() - UNREAD_GRACE_MS)).toISOString());
  if (error) throw error;
  if (!sessions?.length) return 0;
  const { data: reads, error: readError } = await db()
    .from("session_activity")
    .select("workspace_id, read_at")
    .in("workspace_id", sessions.map((s) => s.id));
  if (readError) throw readError;
  const readAt = new Map((reads ?? []).map((r) => [r.workspace_id, r.read_at]));
  return sessions.filter((s) => {
    const read = readAt.get(s.id);
    return !read || Date.parse(read) < Date.parse(s.last_active_at!);
  }).length;
}

/** A Mission's spend in the day or week `at` is in. */
export async function readMissionSpend(missionId: string, kind: SpendPeriodKind, at: Date, now: Date = new Date()): Promise<MissionSpend> {
  const period = spendPeriod(kind, at);
  const ids = await familyIds(missionId);
  const [totalsRes, liabilityRes, intervals, unread] = await Promise.all([
    db().rpc("mission_usage_totals", { target: missionId, from_at: period.start.toISOString(), to_at: period.end.toISOString() }),
    db().rpc("mission_spend_liability", { target: missionId }),
    familyIntervals(ids, period),
    unreadSessions(ids, period, now),
  ]);
  if (totalsRes.error) throw totalsRes.error;
  if (liabilityRes.error) throw liabilityRes.error;
  const t = totalsRes.data?.[0];
  const l = liabilityRes.data?.[0];
  return summarizeSpend({
    missionId,
    kind,
    period,
    totals: {
      reportedUsd: Number(t?.reported_usd ?? 0),
      reportedCalls: Number(t?.reported_calls ?? 0),
      estimatedUsd: Number(t?.estimated_usd ?? 0),
      estimatedCalls: Number(t?.estimated_calls ?? 0),
      unavailableCalls: Number(t?.unavailable_calls ?? 0),
      costBases: t?.cost_bases ?? [],
      tokens: {
        input_tokens: Number(t?.input_tokens ?? 0),
        output_tokens: Number(t?.output_tokens ?? 0),
        cache_creation_input_tokens: Number(t?.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens: Number(t?.cache_read_input_tokens ?? 0),
      },
    },
    intervals,
    unreadSessions: unread,
    liability: {
      heldUsd: Number(l?.held_usd ?? 0),
      uncertainUsd: Number(l?.uncertain_usd ?? 0),
      openReservations: Number(l?.open_reservations ?? 0),
    },
    rate: computeRate(),
    now,
  });
}

// ---------------------------------------------------------------------------
// Policy reservations
// ---------------------------------------------------------------------------

export type Reservation = {
  state: "held" | "lapsed" | "uncertain" | "settled";
  amountUsd: number;
  settledUsd: number | null;
  expiresAt: string;
  /** This call changed nothing: the operation had been made (or settled)
   *  already, and this is how it stands. */
  replayed: boolean;
  /** The Mission's live holds and uncertain liability, after the change. */
  heldUsd: number;
  uncertainUsd: number;
};

type ReservationAnswer = {
  data: { state: Reservation["state"]; amount_usd: number; settled_usd: number | null; expires_at: string; replayed: boolean; held_usd: number; uncertain_usd: number }[] | null;
  error: unknown;
};

function reservation({ data, error }: ReservationAnswer): Reservation {
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("The reservation's change answered nothing.");
  return {
    state: row.state,
    amountUsd: Number(row.amount_usd),
    settledUsd: row.settled_usd === null ? null : Number(row.settled_usd),
    expiresAt: row.expires_at,
    replayed: row.replayed,
    heldUsd: Number(row.held_usd),
    uncertainUsd: Number(row.uncertain_usd),
  };
}

/**
 * Hold `amountUsd` against the Mission's spend for `operationId`, for
 * `holdSeconds`, under the Mission's lock. The same operation again is the
 * same reservation (`replayed`), whatever it asks. Policy only: nothing is
 * charged, and no key's cap moves.
 */
export async function reserveMissionSpend(missionId: string, operationId: string, amountUsd: number, holdSeconds: number): Promise<Reservation> {
  return reservation(
    await db().rpc("reserve_mission_spend", { target: missionId, operation: operationId, amount: amountUsd, hold_seconds: holdSeconds }),
  );
}

/** Hold the operation longer, and at least `amountUsd` (null: as much as
 *  now). Never lowers or shortens a hold; a settled one stays settled. */
export async function renewMissionSpend(missionId: string, operationId: string, amountUsd: number | null, holdSeconds: number): Promise<Reservation> {
  return reservation(
    await db().rpc("renew_mission_spend", { target: missionId, operation: operationId, amount: amountUsd, hold_seconds: holdSeconds }),
  );
}

/** Settle the operation: with its cost known, the hold is released; with it
 *  unknown (null), the hold stays as uncertain liability until settled with
 *  one. Once settled with a cost, a repeat is replayed. */
export async function settleMissionSpend(missionId: string, operationId: string, actualUsd: number | null): Promise<Reservation> {
  return reservation(await db().rpc("settle_mission_spend", { target: missionId, operation: operationId, actual: actualUsd }));
}

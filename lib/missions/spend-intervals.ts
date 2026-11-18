/**
 * A Mission family's compute intervals in a spend period, read on the client
 * given (lib/missions/spend.deps.ts passes the service role's), so the query
 * itself can be tested.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { allRows } from "@/lib/billing/all-rows";
import type { Interval } from "@/lib/billing/hours";
import { LONGEST_INTERVAL_MS } from "@/lib/billing/reconcile";
import type { Database } from "@/lib/supabase/database.types";

/** The family's (`ids`) boxes' intervals that may fall in the period. Two
 *  reads, as the org's (intervalsFor in lib/billing/metering-store.ts), so
 *  each is bounded on the (computer_id, started_at) index: open ones (at most
 *  one a box, so unbounded below) and closed ones started at most
 *  LONGEST_INTERVAL_MS before the period, not every interval a box ever had.
 *  Open first: one closed between the reads is in both, and the closed copy
 *  wins; read the other way round it would be in neither. */
export async function familyIntervalsWith(
  client: SupabaseClient<Database>,
  ids: readonly string[],
  period: { start: Date; end: Date },
): Promise<Interval[]> {
  const { data: computers, error } = await client.from("runtime_computers").select("id").in("workspace_id", [...ids]);
  if (error) throw error;
  const computerIds = (computers ?? []).map((c) => c.id);
  if (!computerIds.length) return [];
  const before = () =>
    client
      .from("compute_intervals")
      .select("id, sandbox_id, cpu, started_at, last_seen_at, ended_at")
      .in("computer_id", computerIds)
      .lt("started_at", period.end.toISOString());
  const open = await allRows((from, to) => before().is("ended_at", null).order("id").range(from, to));
  const closed = await allRows((from, to) =>
    before()
      .gte("started_at", new Date(period.start.getTime() - LONGEST_INTERVAL_MS).toISOString())
      .not("ended_at", "is", null)
      .gt("ended_at", period.start.toISOString())
      .order("id")
      .range(from, to),
  );
  const byId = new Map([...open, ...closed].map((r) => [r.id, r]));
  return [...byId.values()].map((r) => ({
    sandboxId: r.sandbox_id,
    cpu: Number(r.cpu),
    startedAt: new Date(r.started_at),
    lastSeenAt: new Date(r.last_seen_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
  }));
}

/**
 * A Mission family's compute intervals in a spend period, read on the client
 * given (lib/missions/spend.deps.ts passes the service role's), so the query
 * itself can be tested.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { allRows, inBatches } from "@/lib/billing/all-rows";
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
  // In batches of ids: a Mission's Ships grow without bound, and each id is
  // in the request's URL.
  const computers = await inBatches(ids, async (batch) => {
    const { data, error } = await client.from("runtime_computers").select("id").in("workspace_id", batch);
    if (error) throw error;
    return data ?? [];
  });
  const computerIds = computers.map((c) => c.id);
  if (!computerIds.length) return [];
  const before = (batch: string[]) =>
    client
      .from("compute_intervals")
      .select("id, sandbox_id, cpu, started_at, last_seen_at, ended_at")
      .in("computer_id", batch)
      .lt("started_at", period.end.toISOString());
  const open = await inBatches(computerIds, (batch) => allRows((from, to) => before(batch).is("ended_at", null).order("id").range(from, to)));
  const closed = await inBatches(computerIds, (batch) =>
    allRows((from, to) =>
      before(batch)
        .gte("started_at", new Date(period.start.getTime() - LONGEST_INTERVAL_MS).toISOString())
        .not("ended_at", "is", null)
        .gt("ended_at", period.start.toISOString())
        .order("id")
        .range(from, to),
    ),
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

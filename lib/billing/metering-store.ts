/**
 * The database side of cloud hours: compute_intervals, the reconciler's lease,
 * and the computers it looks after. Service role throughout: the reconciler
 * runs for every user at once, with no one signed in, and the tables are
 * service-role only.
 */

import type { Interval, Period } from "@/lib/billing/hours";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { sandboxOf } from "@/lib/runtime/sandbox-choice";
import type { ProviderName } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An interval still open: its box is running, as far as anyone has seen. */
export type OpenInterval = { id: string; sandboxId: string; startedAt: Date; lastSeenAt: Date };

/** A ready computer on one of Outrunner's boxes, with what reaching its agent
 *  takes. */
export type MeteredComputer = {
  id: string;
  ownerId: string;
  projectId: string;
  sandboxId: string;
  agentSecret: string;
};

/** Whether Outrunner pays for boxes `provider` makes, so they're metered: the
 *  deployment's, not a user's own Daytona or Modal. */
export function isMetered(provider: ProviderName | null): boolean {
  return sandboxOf(provider ?? getRuntimeProvider().name) === "outrunner";
}

/** Rows per page: PostgREST answers at most its max-rows (1000 by default),
 *  so a read that could be longer is paged. */
const PAGE_ROWS = 1000;

/** Every row a query matches, a page at a time, in a stable order (`page`
 *  orders by id and takes the range). */
async function allRows<Row>(
  page: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_ROWS) return rows;
  }
}

/** Postgres' unique_violation: the box already has an open interval. */
const UNIQUE_VIOLATION = "23505";

/** Open an interval for `sandboxId`, unless it has one open already. */
export async function openInterval(input: {
  computerId: string;
  sandboxId: string;
  cpu: number;
  at: Date;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { data: computer, error: readError } = await supabase
    .from("runtime_computers")
    .select("owner_id")
    .eq("id", input.computerId)
    .single();
  if (readError) throw readError;
  const { error } = await supabase.from("compute_intervals").insert({
    owner_id: computer.owner_id,
    computer_id: input.computerId,
    sandbox_id: input.sandboxId,
    cpu: input.cpu,
    started_at: input.at.toISOString(),
    last_seen_at: input.at.toISOString(),
  });
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
}

export async function openIntervals(): Promise<OpenInterval[]> {
  const supabase = createSupabaseAdminClient();
  const rows = await allRows((from, to) =>
    supabase
      .from("compute_intervals")
      .select("id, sandbox_id, started_at, last_seen_at")
      .is("ended_at", null)
      .order("id")
      .range(from, to),
  );
  return rows.map((row) => ({
    id: row.id,
    sandboxId: row.sandbox_id,
    startedAt: new Date(row.started_at),
    lastSeenAt: new Date(row.last_seen_at),
  }));
}

/** The owner's intervals overlapping `period`: their cloud hours' raw
 *  material (only Outrunner's boxes are ever metered into the table). Two
 *  reads rather than one `.or()`: an ISO timestamp's dots sit awkwardly in
 *  `.or()`'s comma-separated grammar. */
export async function intervalsFor(ownerId: string, period: Period): Promise<Interval[]> {
  const supabase = createSupabaseAdminClient();
  const columns = "sandbox_id, cpu, started_at, last_seen_at, ended_at";
  const before = () =>
    supabase
      .from("compute_intervals")
      .select(columns)
      .eq("owner_id", ownerId)
      .lt("started_at", period.end.toISOString());
  const open = await allRows((from, to) =>
    before().is("ended_at", null).order("id").range(from, to),
  );
  const closed = await allRows((from, to) =>
    before()
      .not("ended_at", "is", null)
      .gt("ended_at", period.start.toISOString())
      .order("id")
      .range(from, to),
  );
  return [...open, ...closed].map((row) => ({
    sandboxId: row.sandbox_id,
    cpu: row.cpu,
    startedAt: new Date(row.started_at),
    lastSeenAt: new Date(row.last_seen_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
  }));
}

/** The boxes were seen running at `at`. */
export async function touchIntervals(ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("compute_intervals")
    .update({ last_seen_at: at.toISOString() })
    .in("id", ids)
    .is("ended_at", null);
  if (error) throw error;
}

/** End an open interval at `at`. */
export async function closeInterval(id: string, at: Date): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("compute_intervals")
    .update({ ended_at: at.toISOString() })
    .eq("id", id)
    .is("ended_at", null);
  if (error) throw error;
}

/** Every ready computer on a box Outrunner pays for. */
export async function meteredReadyComputers(): Promise<MeteredComputer[]> {
  const supabase = createSupabaseAdminClient();
  const rows = await allRows((from, to) =>
    supabase
      .from("runtime_computers")
      .select("id, owner_id, project_id, daytona_sandbox_id, agent_secret, provider")
      .eq("status", "ready")
      .not("daytona_sandbox_id", "is", null)
      .not("agent_secret", "is", null)
      .order("id")
      .range(from, to),
  );
  return rows
    .filter((row) => isMetered(row.provider as ProviderName | null))
    .map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      projectId: row.project_id,
      sandboxId: row.daytona_sandbox_id as string,
      agentSecret: row.agent_secret as string,
    }));
}

/** Mark a computer stopped, keeping its box id to bring it back from, if it
 *  is still the ready one on that box (a request may have moved it on). */
export async function markStoppedIfReady(id: string, sandboxId: string, reason: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("runtime_computers")
    .update({ status: "stopped", error_message: reason })
    .eq("id", id)
    .eq("status", "ready")
    .eq("daytona_sandbox_id", sandboxId);
  if (error) throw error;
}

/** Take the lease `name` for `seconds`; false when another server holds it. */
export async function claimLease(name: string, seconds: number): Promise<boolean> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("claim_billing_lease", { lease_name: name, seconds });
  if (error) throw error;
  return data === true;
}

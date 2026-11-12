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
import { openAgentSecretOrNull } from "@/lib/db/computer-secret";
import { orgConnectorIds } from "@/lib/db/repositories";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An interval still open: its box is running, as far as anyone has seen.
 *  `agentSeenAt`: when the reconciler last had an answer from its agent
 *  (null: not in this run of the box); undefined on a database from before
 *  the column (20261112140000_box_backstops.sql). */
export type OpenInterval = { id: string; sandboxId: string; startedAt: Date; lastSeenAt: Date; agentSeenAt?: Date | null };

/** A ready computer on one of Outrunner's boxes, with what reaching its agent
 *  takes. Null agentSecret: one whose stored secret won't open, so its agent
 *  can't be reached — metered and stoppable, never pause-on-report. */
export type MeteredComputer = {
  id: string;
  ownerId: string;
  projectId: string;
  /** The session the box is for; null on a project's shared box from before
   *  sessions had their own. */
  workspaceId: string | null;
  sandboxId: string;
  agentSecret: string | null;
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
export async function allRows<Row>(
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
    .select("owner_id, org_id")
    .eq("id", input.computerId)
    .single();
  if (readError) throw readError;
  const { error } = await supabase.from("compute_intervals").insert({
    owner_id: computer.owner_id,
    // Its hours are the org's it ran for (billing is the org's).
    org_id: computer.org_id,
    computer_id: input.computerId,
    sandbox_id: input.sandboxId,
    cpu: input.cpu,
    started_at: input.at.toISOString(),
    last_seen_at: input.at.toISOString(),
  });
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
}

type OpenIntervalRow = { id: string; sandbox_id: string; started_at: string; last_seen_at: string; agent_seen_at?: string | null };

/** Record a box's time running from `startedAt` to `endedAt`, already over:
 *  a warm-pool box's, made, warmed and stopped before any session had it. */
export async function recordInterval(input: {
  ownerId: string;
  /** The org it ran for, whose hours they are. */
  orgId: string;
  computerId: string;
  sandboxId: string;
  cpu: number;
  startedAt: Date;
  endedAt: Date;
}): Promise<void> {
  // Owner and org given, not read off the computer: its row may be gone (a
  // refill the sweep took for dead), and its time still counts.
  const { error } = await createSupabaseAdminClient().from("compute_intervals").insert({
    owner_id: input.ownerId,
    org_id: input.orgId,
    computer_id: input.computerId,
    sandbox_id: input.sandboxId,
    cpu: input.cpu,
    started_at: input.startedAt.toISOString(),
    last_seen_at: input.endedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
  });
  if (error) throw error;
}

export async function openIntervals(): Promise<OpenInterval[]> {
  const supabase = createSupabaseAdminClient();
  const read = (columns: string) =>
    allRows<OpenIntervalRow>((from, to) =>
      supabase
        .from("compute_intervals")
        .select(columns)
        .is("ended_at", null)
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: OpenIntervalRow[] | null; error: unknown }>,
    );
  const base = "id, sandbox_id, started_at, last_seen_at";
  // A database from before agent_seen_at reads without it: the reconciler's
  // unreachable limit is then off, not measured from the box's start.
  const rows = await read(`${base}, agent_seen_at`).catch((error: { code?: string }) => {
    if (probeStatus(error) !== "outdated") throw error;
    return read(base);
  });
  return rows.map((row) => ({
    id: row.id,
    sandboxId: row.sandbox_id,
    startedAt: new Date(row.started_at),
    lastSeenAt: new Date(row.last_seen_at),
    ...("agent_seen_at" in row && { agentSeenAt: row.agent_seen_at ? new Date(row.agent_seen_at) : null }),
  }));
}

/** The intervals overlapping `period` of an org (every member's but its
 *  connector's, which is on its own plan) or one owner (the connector): its
 *  cloud hours' raw
 *  material (only Outrunner's boxes are ever metered into the table). Two
 *  reads rather than one `.or()`: an ISO timestamp's dots sit awkwardly in
 *  `.or()`'s comma-separated grammar. */
export async function intervalsFor(
  whose: { orgId: string } | { ownerId: string },
  period: Period,
): Promise<Interval[]> {
  const supabase = createSupabaseAdminClient();
  const columns = "owner_id, sandbox_id, cpu, started_at, last_seen_at, ended_at";
  const connectors = "orgId" in whose ? await orgConnectorIds(whose.orgId) : new Set<string>();
  const before = () => {
    const query = supabase.from("compute_intervals").select(columns);
    return ("orgId" in whose ? query.eq("org_id", whose.orgId) : query.eq("owner_id", whose.ownerId)).lt(
      "started_at",
      period.end.toISOString(),
    );
  };
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
  return [...open, ...closed].filter((row) => !connectors.has(row.owner_id)).map((row) => ({
    sandboxId: row.sandbox_id,
    cpu: row.cpu,
    startedAt: new Date(row.started_at),
    lastSeenAt: new Date(row.last_seen_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
  }));
}

/** The boxes were seen running at `at`; those of `answered` had their agent
 *  answer too. */
export async function touchIntervals(ids: string[], at: Date, answered: string[] = []): Promise<void> {
  if (ids.length === 0) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("compute_intervals")
    .update({ last_seen_at: at.toISOString() })
    .in("id", ids)
    .is("ended_at", null);
  if (error) throw error;
  if (answered.length === 0) return;
  const { error: agentError } = await supabase
    .from("compute_intervals")
    .update({ agent_seen_at: at.toISOString() })
    .in("id", answered)
    .is("ended_at", null);
  // A database from before the column: nothing to record it in.
  if (agentError && probeStatus(agentError) !== "outdated") throw agentError;
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

/** End `sandboxId`'s open interval at `at`, if it has one (a box has at most
 *  one open). */
export async function closeIntervalOf(sandboxId: string, at: Date): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("compute_intervals")
    .update({ ended_at: at.toISOString() })
    .eq("sandbox_id", sandboxId)
    .is("ended_at", null);
  if (error) throw error;
}

/** Every ready computer on a box Outrunner pays for. */
export async function meteredReadyComputers(): Promise<MeteredComputer[]> {
  const supabase = createSupabaseAdminClient();
  const rows = await allRows((from, to) =>
    supabase
      .from("runtime_computers")
      .select("id, owner_id, project_id, workspace_id, daytona_sandbox_id, agent_secret, provider")
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
      workspaceId: row.workspace_id ?? null,
      sandboxId: row.daytona_sandbox_id as string,
      agentSecret: openAgentSecretOrNull(row.agent_secret, row.id),
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

/** Tell the session on the box why it was paused: a notice on its workspace
 *  (its status unchanged), while it's still a running one. */
export async function noticeWorkspace(workspaceId: string | null, notice: string): Promise<void> {
  if (!workspaceId) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ error_message: notice })
    .eq("id", workspaceId)
    .eq("status", "ready");
  if (error) throw error;
}

/** Clear the notices starting `prefix` from these workspaces: their boxes run
 *  again. One query, whatever the count. */
export async function clearWorkspaceNotices(workspaceIds: string[], prefix: string): Promise<void> {
  if (workspaceIds.length === 0) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ error_message: null })
    .in("id", workspaceIds)
    .like("error_message", `${prefix}%`);
  if (error) throw error;
}

/** Take the lease `name` for `seconds`; false when another server holds it. */
export async function claimLease(name: string, seconds: number): Promise<boolean> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("claim_billing_lease", { lease_name: name, seconds });
  if (error) throw error;
  return data === true;
}

/** The box `computerId` last ran on, as its intervals record: what a row
 *  that lost its box was on (lib/runtime/lost-box.ts). Null when it never
 *  ran on one metered here. */
export async function lastMeteredBox(computerId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("compute_intervals")
    .select("sandbox_id")
    .eq("computer_id", computerId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.sandbox_id ?? null;
}

/**
 * Real wiring for the orphaned-box sweep (lib/runtime/orphan-boxes.ts). Kept
 * apart so the rules stay free of the providers and the database, and tested.
 */

import { allRows, lastMeteredBox } from "@/lib/billing/metering-store";
import { mapWithConcurrency } from "@/lib/concurrency";
import { optionalEnv } from "@/lib/env";
import { boxGone, type ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import {
  atRest,
  boxStatuses,
  COMPUTER_ROLE,
  deploymentName,
  type ListedBox,
  ORPHAN_GRACE_MS,
  orphanedBoxes,
  ROLE_LABEL,
  strayRunningBoxes,
  sweepable,
} from "@/lib/runtime/orphan-boxes";
import { LEFT_BY_CUT_OFF_CLAIM, lostBoxes } from "@/lib/runtime/lost-box";
import { platformComputerProviders } from "@/lib/runtime/provider";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The most boxes one run reads off the account, so a run's work is bounded
 *  however many there are. Only quiet ones are listed: the backlog, and the
 *  paused boxes rows still name. */
const LIST_MAX = 5_000;

/** The held boxes last logged, per backend, so an unchanged list isn't
 *  logged again. */
const lastHeld = new Map<string, string>();

/** Ids asked about per query: a long `in` list makes a long URL. */
const LOOKUP_CHUNK = 100;

/** Newest-interval lookups in flight at once (lostOf): each an indexed
 *  `limit 1` read. */
const LOST_LOOKUP_CONCURRENCY = 4;

/** What one sweep did, on one backend or all. */
export type OrphanSweepReport = { deleted: number; held: number; paused: number };

/**
 * Delete the deployment's boxes that no runtime_computers row names
 * (lib/runtime/orphan-boxes.ts has the rules), on each of Outrunner's own
 * backends it reaches: its own provider's account, and the one it moved from
 * while that one's credentials are set (lib/runtime/provider.ts). A box
 * something dropped without deleting otherwise runs, and costs, for good.
 * Rows of every provider, in every state, are what name a box, so a box an
 * old session still has (a Daytona one, once the deployment runs Neev) is
 * never deleted. Never a user's own Daytona (Settings → Sandbox): theirs,
 * and never listed. For the reconciler's cron. How many went, each one's id
 * logged, and how many were held (orphanedBoxes). One backend failing is
 * logged; the others are still swept.
 */
export async function sweepOrphanedBoxes(now = Date.now()): Promise<OrphanSweepReport> {
  const total: OrphanSweepReport = { deleted: 0, held: 0, paused: 0 };
  // Without a name, this deployment's boxes can't be told from another's.
  const deployment = deploymentName(optionalEnv("RUNTIME_BASE_URL"));
  if (!deployment) return total;
  let failed: unknown = null;
  for (const provider of platformComputerProviders()) {
    try {
      const report = await sweepOrphanedBoxesOf(provider, deployment, now);
      total.deleted += report.deleted;
      total.held += report.held;
      total.paused += report.paused;
    } catch (error) {
      console.error(`Sweeping orphaned ${provider.name} boxes failed`, error);
      failed = error;
    }
  }
  if (failed && total.deleted + total.held + total.paused === 0) throw failed;
  return total;
}

/** The sweep on one backend's account (sweepOrphanedBoxes). */
async function sweepOrphanedBoxesOf(provider: ComputerRuntimeProvider, deployment: string, now: number): Promise<OrphanSweepReport> {
  const what = `${provider.name} box`;
  // Listed quiet ones where the backend can filter; each is checked again
  // here, and only those that could be swept are asked about, so the lookup
  // is as small as the backlog.
  const listing = provider.listBoxes({ [ROLE_LABEL]: COMPUTER_ROLE }, new Date(now - ORPHAN_GRACE_MS));
  if (!listing) return { deleted: 0, held: 0, paused: 0 };
  const candidates: ListedBox[] = [];
  let listed = 0;
  for await (const box of listing) {
    if (sweepable(box, now, deployment)) candidates.push(box);
    if (++listed >= LIST_MAX) break;
  }
  if (candidates.length === 0) {
    // None held now: the same ones coming back are logged again.
    lastHeld.delete(provider.name);
    return { deleted: 0, held: 0, paused: 0 };
  }

  const statusOf = await namedBoxes(candidates.map((box) => box.id));
  // And boxes a row lost track of (a claim cut off mid-way, lib/runtime/lost-box.ts):
  // the next open of its session brings that box back, its files on it.
  const unnamed = candidates.map((box) => box.id).filter((id) => !statusOf.has(id));
  const named = new Set([...statusOf.keys(), ...(await lostOf(unnamed))]);
  // Unlabelled boxes are deleted only on Daytona, and only where the
  // deployment says the account is its alone. A Neev project's untagged
  // boxes (from before tags) are always only held: an operator deletes them.
  const unlabelled = provider.name === "daytona" && optionalEnv("ORPHAN_SWEEP_UNLABELLED") === "1";
  const { remove, held } = orphanedBoxes(candidates, named, { now, deployment, unlabelled });
  // Every one, but only when they change: the cron runs every 2 minutes.
  const heldNow = held.join(", ");
  if (held.length > 0 && heldNow !== lastHeld.get(provider.name)) {
    console.warn(
      `${held.length} orphaned ${what}(es) from before deployment labels, kept` +
        `${provider.name === "daytona" ? " (set ORPHAN_SWEEP_UNLABELLED=1 to delete them)" : ""}: ${heldNow}`,
    );
  }
  lastHeld.set(provider.name, heldNow);
  let swept = 0;
  for (const id of remove) {
    try {
      await provider.destroyComputerOrThrow(id);
      console.warn(`Deleted orphaned ${what} ${id}: no runtime computer names it`);
      swept += 1;
    } catch (error) {
      if (boxGone(error)) continue;
      console.error(`Could not delete orphaned ${what} ${id}`, error);
    }
  }
  // Running under a row that says it isn't: paused, as the row says.
  let paused = 0;
  for (const id of strayRunningBoxes(candidates, statusOf, { now, deployment })) {
    try {
      // Read again just before: a session reopened since the lookup may be
      // bringing this very box back (restore() takes a started box as is).
      if (!(await stillAtRest(id))) continue;
      await provider.pauseComputer(id);
      console.warn(`Paused ${what} ${id}: running while its runtime computer says it is at rest`);
      paused += 1;
    } catch (error) {
      if (boxGone(error)) continue;
      console.error(`Could not pause stray running ${what} ${id}`, error);
    }
  }
  return { deleted: swept, held: held.length, paused };
}

/** Which of `ids` a runtime_computers row names, in any state, pooled or
 *  not, with the status of the row that does (one not at rest, ready or on
 *  its way, over one at rest).
 *  A lookup that fails throws, so nothing is deleted on a guess. */
async function namedBoxes(ids: string[]): Promise<Map<string, string>> {
  const supabase = createSupabaseAdminClient();
  const rows: { sandboxId: string | null; status: string }[] = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("runtime_computers")
      .select("daytona_sandbox_id, status")
      .in("daytona_sandbox_id", ids.slice(i, i + LOOKUP_CHUNK));
    if (error) throw error;
    rows.push(...(data ?? []).map((row) => ({ sandboxId: row.daytona_sandbox_id, status: row.status })));
  }
  return boxStatuses(rows);
}

/** Which of `ids` is the box a row lost (lostBoxes): the newest a computer
 *  ran on, by its intervals, whose row names none while claimed or failed.
 *  From those rows rather than from the boxes' intervals, which grow with
 *  every resume: each row's newest interval alone, so no page cap can cut
 *  off the one that matters. A lookup that fails throws, so nothing is
 *  deleted on a guess. */
async function lostOf(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const supabase = createSupabaseAdminClient();
  const rows = await allRows((from, to) =>
    supabase
      .from("runtime_computers")
      .select("id, status, daytona_sandbox_id")
      .is("daytona_sandbox_id", null)
      .in("status", [...LEFT_BY_CUT_OFF_CLAIM])
      .order("id")
      .range(from, to),
  );
  // Failed fresh provisions and pool refills leave such rows too, and they
  // stay until reopened: a few at a time, not a burst of one per row.
  const withBoxes = await mapWithConcurrency(rows, LOST_LOOKUP_CONCURRENCY, async (row) => ({
    status: row.status,
    daytonaSandboxId: row.daytona_sandbox_id,
    lastBox: await lastMeteredBox(row.id),
  }));
  return lostBoxes(withBoxes, new Set(ids));
}

/** Whether every row naming `sandboxId` still says it's at rest. A lookup
 *  that fails, or finds none, says no: nothing is paused on a guess. */
async function stillAtRest(sandboxId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("status")
    .eq("daytona_sandbox_id", sandboxId);
  // Said, so a lookup failing every run doesn't read as "no strays".
  if (error) console.error(`Could not re-read runtime_computers for box ${sandboxId}`, error);
  if (error || !data?.length) return false;
  return data.every((row) => atRest(row.status));
}

/**
 * Real wiring for the orphaned-box sweep (lib/runtime/orphan-boxes.ts). Kept
 * apart so the rules stay free of Daytona and the database, and tested.
 */

import { optionalEnv } from "@/lib/env";
import { boxGone } from "@/lib/runtime/computer-provider";
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
import { lostBoxes, type MeteredBox } from "@/lib/runtime/lost-box";
import { DaytonaBackend } from "@/lib/runtime/sandbox/daytona";
import type { RuntimeComputerStatus } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The most boxes one run reads off the account, so a run's work is bounded
 *  however many there are. Only quiet ones are listed: the backlog, and the
 *  paused boxes rows still name. */
const LIST_MAX = 5_000;

/** The held boxes last logged, so an unchanged list isn't logged again. */
let lastHeld = "";

/** Ids asked about per query: a long `in` list makes a long URL. */
const LOOKUP_CHUNK = 100;

/**
 * Delete the deployment's Daytona boxes that no runtime_computers row names
 * (lib/runtime/orphan-boxes.ts has the rules): a box something dropped
 * without deleting otherwise runs, and costs, for good. Only ever the
 * deployment's own account (DAYTONA_API_KEY): a user's own Daytona (Settings
 * → Sandbox) is theirs, and never listed. For the reconciler's cron. How
 * many went, each one's id logged, and how many were held (orphanedBoxes).
 */
export async function sweepOrphanedBoxes(now = Date.now()): Promise<{ deleted: number; held: number; paused: number }> {
  // Without a name, this deployment's boxes can't be told from another's.
  const deployment = deploymentName(optionalEnv("RUNTIME_BASE_URL"));
  if (!optionalEnv("DAYTONA_API_KEY") || !deployment) return { deleted: 0, held: 0, paused: 0 };
  const backend = new DaytonaBackend();

  // Daytona lists only the quiet ones; each is checked again here, and only
  // those that could be swept are asked about, so the lookup is as small as
  // the backlog.
  const candidates: ListedBox[] = [];
  let listed = 0;
  for await (const box of backend.list({ [ROLE_LABEL]: COMPUTER_ROLE }, new Date(now - ORPHAN_GRACE_MS))) {
    if (sweepable(box, now, deployment)) candidates.push(box);
    if (++listed >= LIST_MAX) break;
  }
  if (candidates.length === 0) {
    // None held now: the same ones coming back are logged again.
    lastHeld = "";
    return { deleted: 0, held: 0, paused: 0 };
  }

  const statusOf = await namedBoxes(candidates.map((box) => box.id));
  // And boxes a row lost track of (a claim cut off mid-way, lib/runtime/lost-box.ts):
  // the next open of its session brings that box back, its files on it.
  const named = new Set([...statusOf.keys(), ...(await lostOf(candidates.map((box) => box.id)))]);
  const unlabelled = optionalEnv("ORPHAN_SWEEP_UNLABELLED") === "1";
  const { remove, held } = orphanedBoxes(candidates, named, { now, deployment, unlabelled });
  // Every one, but only when they change: the cron runs every 2 minutes.
  const heldNow = held.join(", ");
  if (held.length > 0 && heldNow !== lastHeld) {
    console.warn(
      `${held.length} orphaned Daytona box(es) from before deployment labels, kept (set ORPHAN_SWEEP_UNLABELLED=1 to delete them): ${heldNow}`,
    );
  }
  lastHeld = heldNow;
  let swept = 0;
  for (const id of remove) {
    try {
      await backend.delete(id);
      console.warn(`Deleted orphaned Daytona box ${id}: no runtime computer names it`);
      swept += 1;
    } catch (error) {
      if (boxGone(error)) continue;
      console.error(`Could not delete orphaned Daytona box ${id}`, error);
    }
  }
  // Running under a row that says it isn't: paused, as the row says.
  let paused = 0;
  for (const id of strayRunningBoxes(candidates, statusOf, { now, deployment })) {
    try {
      // Read again just before: a session reopened since the lookup may be
      // bringing this very box back (restore() takes a started box as is).
      if (!(await stillAtRest(id))) continue;
      await backend.pause(id);
      console.warn(`Paused Daytona box ${id}: running while its runtime computer says it is at rest`);
      paused += 1;
    } catch (error) {
      if (boxGone(error)) continue;
      console.error(`Could not pause stray running Daytona box ${id}`, error);
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
 *  ran on, by its intervals, whose row now names none while claimed or
 *  failed. A lookup that fails throws, so nothing is deleted on a guess. */
async function lostOf(ids: string[]): Promise<Set<string>> {
  const supabase = createSupabaseAdminClient();
  const computerIds = new Set<string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("compute_intervals")
      .select("computer_id")
      .in("sandbox_id", ids.slice(i, i + LOOKUP_CHUNK));
    if (error) throw error;
    for (const row of data ?? []) if (row.computer_id) computerIds.add(row.computer_id);
  }
  const computers = [...computerIds];
  const intervals: MeteredBox[] = [];
  const rows: { id: string; status: RuntimeComputerStatus; daytonaSandboxId: string | null }[] = [];
  for (let i = 0; i < computers.length; i += LOOKUP_CHUNK) {
    const chunk = computers.slice(i, i + LOOKUP_CHUNK);
    const [ran, named] = await Promise.all([
      supabase.from("compute_intervals").select("computer_id, sandbox_id, started_at").in("computer_id", chunk),
      supabase.from("runtime_computers").select("id, status, daytona_sandbox_id").in("id", chunk),
    ]);
    if (ran.error) throw ran.error;
    if (named.error) throw named.error;
    for (const row of ran.data ?? []) {
      if (row.computer_id) intervals.push({ computerId: row.computer_id, sandboxId: row.sandbox_id, startedAt: row.started_at });
    }
    rows.push(...(named.data ?? []).map((row) => ({ id: row.id, status: row.status, daytonaSandboxId: row.daytona_sandbox_id })));
  }
  return lostBoxes(intervals, rows);
}

/** Whether every row naming `sandboxId` still says it's at rest. A lookup
 *  that fails, or finds none, says no: nothing is paused on a guess. */
async function stillAtRest(sandboxId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("status")
    .eq("daytona_sandbox_id", sandboxId);
  // Said, so a lookup failing every run doesn't read as "no strays".
  if (error) console.error(`Could not re-read runtime_computers for Daytona box ${sandboxId}`, error);
  if (error || !data?.length) return false;
  return data.every((row) => atRest(row.status));
}

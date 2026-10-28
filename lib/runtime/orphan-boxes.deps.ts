/**
 * Real wiring for the orphaned-box sweep (lib/runtime/orphan-boxes.ts). Kept
 * apart so the rules stay free of Daytona and the database, and tested.
 */

import { optionalEnv } from "@/lib/env";
import { boxGone } from "@/lib/runtime/computer-provider";
import {
  COMPUTER_ROLE,
  deploymentName,
  type ListedBox,
  ORPHAN_GRACE_MS,
  orphanedBoxes,
  ROLE_LABEL,
  sweepable,
} from "@/lib/runtime/orphan-boxes";
import { DaytonaBackend } from "@/lib/runtime/sandbox/daytona";
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
export async function sweepOrphanedBoxes(now = Date.now()): Promise<{ deleted: number; held: number }> {
  // Without a name, this deployment's boxes can't be told from another's.
  const deployment = deploymentName(optionalEnv("RUNTIME_BASE_URL"));
  if (!optionalEnv("DAYTONA_API_KEY") || !deployment) return { deleted: 0, held: 0 };
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
  if (candidates.length === 0) return { deleted: 0, held: 0 };

  const named = await namedBoxes(candidates.map((box) => box.id));
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
  return { deleted: swept, held: held.length };
}

/** Which of `ids` a runtime_computers row names, in any state, pooled or
 *  not. A lookup that fails throws, so nothing is deleted on a guess. */
async function namedBoxes(ids: string[]): Promise<Set<string>> {
  const supabase = createSupabaseAdminClient();
  const named = new Set<string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("runtime_computers")
      .select("daytona_sandbox_id")
      .in("daytona_sandbox_id", ids.slice(i, i + LOOKUP_CHUNK));
    if (error) throw error;
    for (const row of data ?? []) if (row.daytona_sandbox_id) named.add(row.daytona_sandbox_id);
  }
  return named;
}

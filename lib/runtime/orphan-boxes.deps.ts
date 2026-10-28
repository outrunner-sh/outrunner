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
  orphanedBoxes,
  ROLE_LABEL,
  sweepable,
} from "@/lib/runtime/orphan-boxes";
import { DaytonaBackend } from "@/lib/runtime/sandbox/daytona";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The most boxes one run reads off the account, so a run's work is bounded
 *  however many there are. */
const LIST_MAX = 5_000;

/** Ids asked about per query: a long `in` list makes a long URL. */
const LOOKUP_CHUNK = 100;

/**
 * Delete the deployment's Daytona boxes that no runtime_computers row names
 * (lib/runtime/orphan-boxes.ts has the rules): a box something dropped
 * without deleting otherwise runs, and costs, for good. Only ever the
 * deployment's own account (DAYTONA_API_KEY): a user's own Daytona (Settings
 * → Sandbox) is theirs, and never listed. For the reconciler's cron. How
 * many went; each one's id is logged.
 */
export async function sweepOrphanedBoxes(now = Date.now()): Promise<number> {
  if (!optionalEnv("DAYTONA_API_KEY")) return 0;
  const backend = new DaytonaBackend();
  const deployment = deploymentName(optionalEnv("RUNTIME_BASE_URL"));

  // Only the ones that could be swept are asked about, so the lookup is as
  // small as the backlog.
  const candidates: ListedBox[] = [];
  let listed = 0;
  for await (const box of backend.list({ [ROLE_LABEL]: COMPUTER_ROLE })) {
    if (sweepable(box, now, deployment)) candidates.push(box);
    if (++listed >= LIST_MAX) break;
  }
  if (candidates.length === 0) return 0;

  const named = await namedBoxes(candidates.map((box) => box.id));
  let swept = 0;
  for (const id of orphanedBoxes(candidates, named, { now, deployment })) {
    try {
      await backend.delete(id);
      console.warn(`Deleted orphaned Daytona box ${id}: no runtime computer names it`);
      swept += 1;
    } catch (error) {
      if (boxGone(error)) continue;
      console.error(`Could not delete orphaned Daytona box ${id}`, error);
    }
  }
  return swept;
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

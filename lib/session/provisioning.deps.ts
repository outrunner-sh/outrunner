/**
 * Real wiring for setup's rules (lib/session/provisioning.ts). Kept apart so
 * the rules stay free of the database, and importable by the session page.
 */

import {
  abandonedBoxClaim,
  BOX_CLAIM_ABANDONED_AFTER_MS,
  INTERRUPTED_TRANSITIONS,
  interruptedSetups,
  transitionsInterruptedBefore,
} from "@/lib/session/provisioning";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Fail the sessions whose setup a restart or a deploy cut off
 * (interruptedSetups), so their page says so, with its Try again and Delete,
 * rather than spinning on a step for good. Only after() sets a session up,
 * and nothing else ends one cut off. One statement, its conditions checked
 * again on a row changed meanwhile, so a setup that wrote its next step, or
 * ended, is left alone; and its own write later finds the session no longer
 * setting up, as a deleted one's would. For the reconciler's cron. How many.
 */
export async function sweepInterruptedSetups(now = new Date()): Promise<number> {
  const { from, unchangedSince, patch } = interruptedSetups(now);
  const { data, error } = await createSupabaseAdminClient()
    .from("workspaces")
    .update({ status: patch.status, error_message: patch.errorMessage })
    .in("status", from)
    .lt("updated_at", unchangedSince)
    .select("id");
  if (error) throw error;
  // Which ones, as a deploy is what fails them: the cron answers a count.
  const ids = (data ?? []).map((row) => row.id);
  if (ids.length > 0) console.warn(`Failed ${ids.length} interrupted session setup(s): ${ids.join(", ")}`);
  return ids.length;
}

/**
 * Move each session a lifecycle step left behind (INTERRUPTED_TRANSITIONS),
 * its row unchanged since TRANSITION_INTERRUPTED_AFTER_MS ago, back to where
 * the step started, saying so. An archive cut off once its Snapshot was kept
 * is archived. Conditional on the status and the time, so a step still going,
 * which writes as it ends, is left alone. For the reconciler's cron. How many.
 */
export async function sweepInterruptedTransitions(now = new Date()): Promise<number> {
  const db = createSupabaseAdminClient();
  const before = transitionsInterruptedBefore(now);
  const moved: string[] = [];

  // Archived but for its last write: the Snapshot, kept after the step began.
  const { data: archiving, error: archivingError } = await db
    .from("workspaces")
    .select("id, updated_at")
    .eq("status", "archiving")
    .lt("updated_at", before);
  if (archivingError) throw archivingError;
  for (const row of archiving ?? []) {
    const { data: kept, error } = await db
      .from("workspace_snapshots")
      .select("id")
      .eq("workspace_id", row.id)
      .gte("created_at", row.updated_at)
      .limit(1);
    if (error) throw error;
    if (!kept?.length) continue;
    const { data, error: updateError } = await db
      .from("workspaces")
      .update({ status: "archived", error_message: null })
      .eq("id", row.id)
      .eq("status", "archiving")
      .eq("updated_at", row.updated_at)
      .select("id");
    if (updateError) throw updateError;
    moved.push(...(data ?? []).map((r) => r.id));
  }

  for (const { from, to, message } of INTERRUPTED_TRANSITIONS) {
    const { data, error } = await db
      .from("workspaces")
      .update({ status: to, error_message: message })
      .eq("status", from)
      .lt("updated_at", before)
      .select("id");
    if (error) throw error;
    moved.push(...(data ?? []).map((r) => r.id));
  }
  if (moved.length > 0) console.warn(`Ended ${moved.length} interrupted lifecycle step(s): ${moved.join(", ")}`);
  return moved.length;
}

/**
 * Let go of each claim on a box whose provision was cut off: a box row (not
 * a pooled one, which sweepAbandonedPools has) still provisioning, unchanged
 * since BOX_CLAIM_ABANDONED_AFTER_MS ago, becomes what its provision's own
 * failure would have left (abandonedBoxClaim), so the next claim takes it
 * over. How many, and the boxes stopped as their rows now say, for the caller
 * to pause: one brought back part way may be running.
 */
export async function sweepAbandonedBoxClaims(now = new Date()): Promise<{ released: number; stopped: string[] }> {
  const db = createSupabaseAdminClient();
  const before = new Date(now.getTime() - BOX_CLAIM_ABANDONED_AFTER_MS).toISOString();
  const { data: claims, error } = await db
    .from("runtime_computers")
    .select("id, daytona_sandbox_id, updated_at")
    .eq("status", "provisioning")
    .eq("pooled", false)
    .lt("updated_at", before);
  if (error) throw error;
  const stopped: string[] = [];
  let released = 0;
  for (const claim of claims ?? []) {
    const { status, errorMessage } = abandonedBoxClaim(claim.daytona_sandbox_id);
    const { data, error: updateError } = await db
      .from("runtime_computers")
      .update({ status, error_message: errorMessage })
      .eq("id", claim.id)
      .eq("status", "provisioning")
      .eq("updated_at", claim.updated_at)
      .select("id");
    if (updateError) throw updateError;
    if (!data?.length) continue;
    released++;
    if (status === "stopped" && claim.daytona_sandbox_id) stopped.push(claim.daytona_sandbox_id);
    console.warn(`Let go of box claim ${claim.id}, cut off mid-provision (now ${status})`);
  }
  return { released, stopped };
}

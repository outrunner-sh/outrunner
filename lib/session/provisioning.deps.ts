/**
 * Real wiring for setup's rules (lib/session/provisioning.ts). Kept apart so
 * the rules stay free of the database, and importable by the session page.
 */

import { interruptedSetups } from "@/lib/session/provisioning";
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

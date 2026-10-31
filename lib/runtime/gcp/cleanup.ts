import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { gcpConnection } from "@/lib/db/gcp";
import { GcpBackend } from "@/lib/runtime/sandbox/gcp";
import { probeStatus } from "@/lib/supabase/probe";

/** A recorded intent is the only authority to sweep. Never enumerate arbitrary
 * customer VMs or delete on a failed database lookup. Two hours protects any
 * create/verify still under way. A bounded run retries failed deletes too. */
export async function sweepGcpResources(): Promise<number> {
  const db = createSupabaseAdminClient();
  const { data: resources, error } = await db.rpc("gcp_cleanup_candidates", { older_than: new Date(Date.now() - 2 * 3600_000).toISOString() });
  if (error) { if (error.code === "PGRST202" || ["missing", "outdated"].includes(probeStatus(error))) return 0; throw error; }
  let deleted = 0;
  for (const r of resources) {
    const { count, error: lookupError } = await db.from("runtime_computers").select("id", { count: "exact", head: true }).eq("provider", "user-gcp").eq("daytona_sandbox_id", r.id);
    if (lookupError) throw lookupError;
    if (count && r.state !== "deleting") continue;
    const c = await gcpConnection(r.user_id, r.connection_id);
    if (!c) continue;
    try { await new GcpBackend(r.user_id, async () => c).delete(r.id); deleted += 1; }
    catch { console.error(`Could not clean up recorded GCP sandbox ${r.id}; it remains in the resource ledger for retry.`); }
    if (deleted >= 10) break;
  }
  return deleted;
}

/**
 * An org's usage controls and the alerts sent under them
 * (20261101100000_org_usage_controls.sql; lib/billing/usage-controls.ts).
 * The server's alone: the admin route has checked the caller is the org's
 * admin; the reconciler runs as the server.
 */

import {
  ALERT_THRESHOLDS,
  type AlertThreshold,
  DEFAULT_USAGE_CONTROLS,
  type UsageControls,
} from "@/lib/billing/usage-controls";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The org's controls; the defaults with none set, or before the migration. */
export async function getUsageControls(orgId: string): Promise<UsageControls> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .select("usage_limit_percent, alert_thresholds")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error && ["missing", "outdated"].includes(probeStatus(error))) return DEFAULT_USAGE_CONTROLS;
  if (error) throw error;
  if (!data) return DEFAULT_USAGE_CONTROLS;
  return {
    limitPercent: data.usage_limit_percent ?? null,
    alertThresholds: (data.alert_thresholds ?? []).filter((t): t is AlertThreshold =>
      (ALERT_THRESHOLDS as readonly number[]).includes(t),
    ),
  };
}

/** The org's controls on a box's way: the defaults, said in the log, when
 *  they can't be read, rather than no box. */
export function usageControlsFor(orgId: string): Promise<UsageControls> {
  return getUsageControls(orgId).catch((error: unknown) => {
    console.error(`Couldn't read org ${orgId}'s usage controls; going on with the defaults`, error);
    return DEFAULT_USAGE_CONTROLS;
  });
}

/** Set the org's controls, as admin `by`. */
export async function setUsageControls(orgId: string, controls: UsageControls, by: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .upsert(
      {
        org_id: orgId,
        usage_limit_percent: controls.limitPercent,
        alert_thresholds: controls.alertThresholds,
        updated_by: by,
      },
      { onConflict: "org_id" },
    );
  if (error) throw error;
}

/** The thresholds already alerted for the org's period starting `periodStart`. */
export async function sentAlerts(orgId: string, periodStart: Date): Promise<Set<number>> {
  const { data, error } = await createSupabaseAdminClient()
    .from("org_usage_alerts")
    .select("threshold")
    .eq("org_id", orgId)
    .eq("period_start", periodStart.toISOString());
  if (error && probeStatus(error) === "missing") return new Set(ALERT_THRESHOLDS);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.threshold));
}

/** Record an alert as sent; false when it was already (another run sent it). */
export async function claimAlert(orgId: string, periodStart: Date, threshold: number): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("org_usage_alerts")
    .upsert(
      { org_id: orgId, period_start: periodStart.toISOString(), threshold },
      { onConflict: "org_id,period_start,threshold", ignoreDuplicates: true },
    )
    .select("org_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

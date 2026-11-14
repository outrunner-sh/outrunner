/**
 * Where an org's cloud hours stand this period, for Settings → Org → Usage:
 * used, the plan's, and the cap its admins' limit sets.
 */

import { entitlementsFor } from "@/lib/billing/entitlements";
import { calendarMonth, hoursUsed } from "@/lib/billing/hours";
import { intervalsFor } from "@/lib/billing/metering-store";
import { hoursCap, type UsageControls } from "@/lib/billing/usage-controls";

/** Null planHours/cap means unlimited, including in JSON API responses. */
export type OrgHours = { used: number; planHours: number | null; cap: number | null; planLabel: string; periodEnd: string };

export async function orgHours(orgId: string, controls: UsageControls, now = new Date()): Promise<OrgHours> {
  const { plan, allowancePeriod } = await entitlementsFor(orgId, now);
  const period = allowancePeriod ?? calendarMonth(now);
  const used = hoursUsed(await intervalsFor({ orgId }, period), period, now);
  return {
    used: Math.round(used * 10) / 10,
    planHours: plan.cloudHoursPerMonth,
    cap: hoursCap(plan, controls),
    planLabel: plan.label,
    periodEnd: period.end.toISOString(),
  };
}

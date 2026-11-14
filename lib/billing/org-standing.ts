/**
 * Where an org's cloud usage stands this period, for Settings → Org → Usage
 * and GET /api/v1/usage: what it has used of its plan's included usage, any
 * overage, the admins' limit, and what that leaves it.
 */

import { type AccountStanding, accountStanding } from "@/lib/billing/standing";
import { ALL_TIME, type UsageState } from "@/lib/billing/usage";
import { takesLimit, thresholdsFor, type AlertThreshold, type UsageControls } from "@/lib/billing/usage-controls";
import { getUsageControls } from "@/lib/db/org-usage";

/** In whole cents, as JSON. */
export type OrgUsage = {
  planLabel: string;
  state: UsageState;
  /** What the plan includes a period (the trial: once). */
  includedCapCents: number;
  /** What it has used of that. */
  includedCents: number;
  /** Usage past it, billed at the overage rate. */
  overageCents: number;
  /** Included plus overage. */
  totalCents: number;
  /** The admins' limit as it applies (never below the included); null for none. */
  limitCents: number | null;
  /** Whether usage past the included is billed (true) or stops there. */
  overage: boolean;
  /** Whether the plan takes a limit (only one with overage does). */
  takesLimit: boolean;
  /** The alerts that mean something on the plan. */
  alertThresholds: readonly AlertThreshold[];
  /** When the period resets; null for the trial, which never does. */
  periodEnd: string | null;
};

export function orgUsageView({ plan, period, standing }: AccountStanding): OrgUsage {
  return {
    planLabel: plan.label,
    state: standing.state,
    includedCapCents: standing.includedCapCents,
    includedCents: standing.includedCents,
    overageCents: standing.overageCents,
    totalCents: standing.totalCents,
    limitCents: standing.limitCents,
    overage: plan.usage.overage,
    takesLimit: takesLimit(plan),
    alertThresholds: thresholdsFor(plan),
    periodEnd: period.end.getTime() === ALL_TIME.end.getTime() ? null : period.end.toISOString(),
  };
}

/** The org's controls and where its usage stands, as the page and API show them. */
export async function orgUsage(orgId: string, now = new Date()): Promise<{ controls: UsageControls; usage: OrgUsage }> {
  const account = await accountStanding({ orgId }, now, getUsageControls);
  return { controls: account.controls, usage: orgUsageView(account) };
}

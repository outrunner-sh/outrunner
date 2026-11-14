/**
 * An org's admins' controls over its cloud usage (Settings → Org → Usage;
 * 20261114120000_usage_limits_in_dollars.sql): a limit in dollars on what
 * the org spends in a period, included usage and overage together, and
 * email alerts at shares of the plan's included usage. Pure, for the start
 * gate, the usage sweep, the settings route and the tests.
 */

import type { Plan } from "@/lib/billing/plans";
import type { UsageStanding } from "@/lib/billing/usage";

export const ALERT_THRESHOLDS = [50, 80, 100, 150, 200] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

export type UsageControls = {
  /** What the org may spend on cloud usage a period, in USD; null: no limit. */
  limitUsd: number | null;
  /** The shares of the plan's included usage at which its admins are
   *  emailed, once each per period. */
  alertThresholds: AlertThreshold[];
};

export const DEFAULT_USAGE_CONTROLS: UsageControls = { limitUsd: null, alertThresholds: [80, 100] };

/** Where an org's admins set them. */
export const USAGE_CONTROLS_HREF = "/settings/org/usage";

/** The most a limit may be: a typo guard, not a business rule. */
export const MAX_LIMIT_USD = 100_000;

/** Whether `plan` takes a limit at all: only one billing overage does. A
 *  plan without stops at what it includes, so a limit has nothing to cap. */
export function takesLimit(plan: Plan): boolean {
  return plan.usage.overage;
}

/** The alerts that mean something on `plan`: past 100% only where usage
 *  can go past what the plan includes. */
export function thresholdsFor(plan: Plan): readonly AlertThreshold[] {
  return plan.usage.overage ? ALERT_THRESHOLDS : ALERT_THRESHOLDS.filter((t) => t <= 100);
}

/**
 * The limit that applies on `plan`: none on a plan without overage, and
 * never below what the plan includes, which is paid for already. A limit
 * set on a smaller plan stays saved; after an upgrade it reads as the new
 * plan's included usage until an admin raises it.
 */
export function limitFor(plan: Plan, controls: UsageControls): number | null {
  if (!takesLimit(plan) || controls.limitUsd === null) return null;
  return Math.max(controls.limitUsd, plan.usage.includedUsd);
}

/** The thresholds the usage has crossed that aren't in `sent`, lowest
 *  first: the alerts to send now. */
export function alertsDue(
  plan: Plan,
  standing: UsageStanding,
  controls: UsageControls,
  sent: ReadonlySet<number>,
): AlertThreshold[] {
  if (standing.includedCapCents <= 0) return [];
  const share = (standing.totalCents / standing.includedCapCents) * 100;
  const meaningful = thresholdsFor(plan);
  return [...controls.alertThresholds]
    .sort((a, b) => a - b)
    .filter((t) => meaningful.includes(t) && share >= t && !sent.has(t));
}

/** A share as posted: one of ALERT_THRESHOLDS, or null. */
export function postedThreshold(value: unknown): AlertThreshold | null {
  return ALERT_THRESHOLDS.find((t) => t === value) ?? null;
}

/**
 * A limit as posted for `plan`, in USD: null for none; a whole-cent amount
 * from the plan's included usage to MAX_LIMIT_USD; undefined for anything
 * else, including any limit on a plan that takes none.
 */
export function postedLimitUsd(value: unknown, plan: Plan): number | null | undefined {
  if (value === null) return null;
  if (!takesLimit(plan)) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6) return undefined;
  const usd = cents / 100;
  return usd >= plan.usage.includedUsd && usd <= MAX_LIMIT_USD ? usd : undefined;
}

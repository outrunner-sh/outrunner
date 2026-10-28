/**
 * An org's admins' controls over its cloud usage (Settings → Org → Usage;
 * 20261101100000_org_usage_controls.sql), within its plan's cloud hours: a
 * limit at a share of them, and alerts at shares of them. Pure, for the start
 * gate, the reconciler and the tests.
 */

import type { CloudLimitDenial } from "@/lib/billing/limits";
import type { Plan } from "@/lib/billing/plans";

export const ALERT_THRESHOLDS = [50, 80, 100] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

export type UsageControls = {
  /** The share of the plan's hours the org may use; null: all of them. */
  limitPercent: number | null;
  /** The shares at which its admins are emailed, once each per period. */
  alertThresholds: AlertThreshold[];
};

export const DEFAULT_USAGE_CONTROLS: UsageControls = { limitPercent: null, alertThresholds: [80, 100] };

/** Where an org's admins set them. */
export const USAGE_CONTROLS_HREF = "/settings/org/usage";

/** The hours the org may use this period: its limit's share of the plan's. */
export function hoursCap(plan: Plan, controls: UsageControls): number {
  return controls.limitPercent === null ? plan.cloudHoursPerMonth : (plan.cloudHoursPerMonth * controls.limitPercent) / 100;
}

/** Whether the org has reached the limit its admins set (not its plan's,
 *  which hoursDenial says). */
export function overLimit(plan: Plan, controls: UsageControls, used: number): boolean {
  return controls.limitPercent !== null && controls.limitPercent < 100 && used >= hoursCap(plan, controls);
}

/** The refusal for a box starting past the admins' limit. */
export function limitDenial(plan: Plan, controls: UsageControls, used: number): CloudLimitDenial | null {
  if (!overLimit(plan, controls, used)) return null;
  return {
    error: `Your org's usage limit (${controls.limitPercent}% of its plan's ${plan.cloudHoursPerMonth} cloud hours) is reached for this period. An admin can raise it in Settings → Org → Usage.`,
    settingsHref: USAGE_CONTROLS_HREF,
  };
}

/** The thresholds `used` hours has crossed that aren't in `sent`, lowest
 *  first: the alerts to send now. */
export function alertsDue(plan: Plan, controls: UsageControls, used: number, sent: ReadonlySet<number>): AlertThreshold[] {
  if (plan.cloudHoursPerMonth <= 0) return [];
  const share = (used / plan.cloudHoursPerMonth) * 100;
  return [...controls.alertThresholds].sort((a, b) => a - b).filter((t) => share >= t && !sent.has(t));
}

/** A share as posted: one of ALERT_THRESHOLDS, or null. */
export function postedThreshold(value: unknown): AlertThreshold | null {
  return ALERT_THRESHOLDS.find((t) => t === value) ?? null;
}

/** A limit as posted: a whole percent from 10 to 100, or null for none;
 *  undefined for anything else. */
export function postedLimit(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 10 && value <= 100 ? value : undefined;
}

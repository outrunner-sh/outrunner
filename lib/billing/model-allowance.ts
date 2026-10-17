/**
 * The allowance on Outrunner's models, kept as the cap on the user's own
 * OpenRouter key (lib/openrouter/keys.ts). OpenRouter counts a key's spend
 * over its whole life, so the cap moves instead of resetting: each period, it
 * becomes what the key has spent plus the plan's allowance, and that spend is
 * the period's baseline. Periods follow the user's billing, not the calendar
 * month OpenRouter's own reset would. Pure: the caller reads the key and
 * stores the state.
 */

import type { Entitlements } from "@/lib/billing/entitlements";
import type { PlanId } from "@/lib/billing/plans";

/** Where a user's allowance stands, as stored beside their key. */
export type AllowanceState = {
  /** "once" for a one-time allowance (Free); else the period's start (ISO). */
  period: string;
  plan: PlanId;
  /** What the key had spent when this allowance began. */
  baselineUsd: number;
  /** The key's cap: baseline plus the allowance. */
  limitUsd: number;
};

export const ONCE = "once";

/**
 * The state the key should be in for `entitlements` now, given the state
 * stored (null for none yet) and what the key has spent. Null when the stored
 * state still holds.
 *
 *   - A one-time allowance (Free) is the plan's amount over the key's life:
 *     the cap is that amount, or what's spent already if more (back from a
 *     paid plan, nothing more is free).
 *   - A new period: the cap is what's spent plus the plan's allowance.
 *   - A plan change within a period (an upgrade, at once): the period's
 *     baseline stays and the cap becomes baseline plus the new allowance,
 *     never below what's spent.
 */
export function nextAllowance(
  entitlements: Entitlements,
  stored: AllowanceState | null,
  spentUsd: number,
): AllowanceState | null {
  const { plan, allowancePeriod } = entitlements;
  const usd = plan.models.usd;
  if (plan.models.per === "once" || !allowancePeriod) {
    if (stored?.period === ONCE && stored.plan === plan.id) return null;
    const limitUsd = Math.max(usd, spentUsd);
    return { period: ONCE, plan: plan.id, baselineUsd: limitUsd - usd, limitUsd };
  }
  const period = allowancePeriod.start.toISOString();
  if (stored?.period === period) {
    if (stored.plan === plan.id) return null;
    return { period, plan: plan.id, baselineUsd: stored.baselineUsd, limitUsd: Math.max(spentUsd, stored.baselineUsd + usd) };
  }
  return { period, plan: plan.id, baselineUsd: spentUsd, limitUsd: spentUsd + usd };
}

/** What the sidebar shows: spent and cap within the allowance, so a period
 *  starts at 0%. */
export function allowanceWithin(state: AllowanceState, spentUsd: number): { usedUsd: number; limitUsd: number } {
  return { usedUsd: spentUsd - state.baselineUsd, limitUsd: state.limitUsd - state.baselineUsd };
}

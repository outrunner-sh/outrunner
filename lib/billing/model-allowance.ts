/**
 * The allowance on Outrunner's models, kept as the cap on the user's own
 * OpenRouter key (lib/openrouter/keys.ts). OpenRouter counts a key's spend
 * over its whole life, so the cap moves instead of resetting: each period, it
 * becomes what the key has spent plus the plan's allowance, and that spend is
 * the period's baseline. Periods follow the user's billing, not the calendar
 * month OpenRouter's own reset would. The I/O is behind {@link AllowanceStore}
 * and {@link AllowanceDeps}.
 */

import type { Entitlements } from "@/lib/billing/entitlements";
import type { PlanId } from "@/lib/billing/plans";
import { allowanceSpent, type Allowance } from "@/lib/openrouter/allowance";
import { AllowanceSpentError, ModelKeyDisabledError, type KeyUsage } from "@/lib/openrouter/keys";

/** Where a user's allowance stands, as stored beside their key. */
export type AllowanceState = {
  /** "once" for a one-time allowance (Free); else the period's start (ISO). */
  period: string;
  plan: PlanId;
  /** What the key had spent when this allowance began. */
  baselineUsd: number;
  /** The key's cap: baseline plus the allowance; null for unlimited. */
  limitUsd: number | null;
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
  if (usd === null) {
    const period = allowancePeriod?.start.toISOString() ?? ONCE;
    if (stored?.period === period && stored.plan === plan.id && stored.limitUsd === null) return null;
    return {
      period,
      plan: plan.id,
      baselineUsd: stored?.period === period ? stored.baselineUsd : spentUsd,
      limitUsd: null,
    };
  }
  if (plan.models.per === "once" || !allowancePeriod) {
    if (stored?.period === ONCE && stored.plan === plan.id && stored.limitUsd !== null) return null;
    const limitUsd = cents(Math.max(usd, spentUsd));
    return { period: ONCE, plan: plan.id, baselineUsd: limitUsd - usd, limitUsd };
  }
  const period = allowancePeriod.start.toISOString();
  if (stored?.period === period) {
    if (stored.plan === plan.id && stored.limitUsd !== null) return null;
    return {
      period,
      plan: plan.id,
      baselineUsd: stored.baselineUsd,
      limitUsd: cents(Math.max(spentUsd, stored.baselineUsd + usd)),
    };
  }
  return { period, plan: plan.id, baselineUsd: spentUsd, limitUsd: cents(spentUsd + usd) };
}

/** A cap, to the cent: what OpenRouter keeps. */
function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** OpenRouter's cap matches the stored one to within half a cent. */
const SAME_CAP_WITHIN_USD = 0.005;

export type AllowanceStore = {
  /** The user's key (its id) and the state stored beside it. */
  read(): Promise<{ hash: string | null; state: AllowanceState | null }>;
  /** Store `next` only if the stored state is still `previous`: false when
   *  another call moved it first. */
  claim(previous: AllowanceState | null, next: AllowanceState): Promise<boolean>;
};

export type AllowanceDeps = {
  usage(hash: string): Promise<KeyUsage>;
  setLimit(hash: string, limitUsd: number | null): Promise<void>;
  entitlements(): Promise<Entitlements>;
};

/**
 * Bring the cap on the user's key in line with their plan and period, and say
 * where it stands within the allowance; null with no key yet.
 *
 * A period's state is claimed in the database before the cap moves, so two
 * calls at once settle on one baseline (the loser uses the winner's), and
 * one period can't grant twice. The key's cap then follows whatever is
 * stored, every time: a cap that failed to move after a claim is moved on the
 * next call, not lost.
 */
export async function refreshAllowance(
  store: AllowanceStore,
  deps: AllowanceDeps,
): Promise<RefreshedAllowance | null> {
  const { hash, state } = await store.read();
  if (!hash) return null;
  const usage = await deps.usage(hash);
  let current = state;
  const next = nextAllowance(await deps.entitlements(), state, usage.usedUsd);
  if (next) current = (await store.claim(state, next)) ? next : (await store.read()).state;
  if (!current) throw new Error("A model allowance was claimed but none is stored.");
  if (
    usage.limitUsd !== current.limitUsd &&
    (usage.limitUsd === null ||
      current.limitUsd === null ||
      Math.abs(usage.limitUsd - current.limitUsd) > SAME_CAP_WITHIN_USD)
  ) {
    await deps.setLimit(hash, current.limitUsd);
  }
  return { ...allowanceWithin(current, usage.usedUsd), disabled: usage.disabled };
}

/** Where the allowance stands after a refresh, and whether OpenRouter has the
 *  key disabled. */
export type RefreshedAllowance = Allowance & { disabled: boolean };

/**
 * Refuse a key that can't run anything: one disabled on OpenRouter, or one
 * whose allowance is spent. Null (no key yet, or the refresh failed) passes:
 * there's nothing to judge, and OpenRouter's own cap still holds.
 */
export function refuseUnusable(allowance: RefreshedAllowance | null): void {
  if (!allowance) return;
  if (allowance.disabled) throw new ModelKeyDisabledError();
  if (allowanceSpent(allowance)) throw new AllowanceSpentError();
}

/** What the sidebar shows: spent and cap within the allowance, so a period
 *  starts at 0%. */
export function allowanceWithin(state: AllowanceState, spentUsd: number): Allowance {
  return {
    usedUsd: spentUsd - state.baselineUsd,
    limitUsd: state.limitUsd === null ? null : state.limitUsd - state.baselineUsd,
  };
}

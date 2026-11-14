/**
 * Cloud usage in dollars: what an org's boxes cost in a period, and where
 * that leaves it against its plan. Pure, so the pricing rules are tested
 * without a database or Stripe.
 *
 * A box costs per vCPU-minute it runs, so a Medium (4 vCPU) minute costs
 * twice a Small's. A plan includes usage worth `usage.includedUsd` at the
 * included rate; usage past it is billed at the overage rate (1.5x), on a
 * plan that has overage, and stops a plan that doesn't (the trial, a
 * contract's fixed terms). Rates are the same for every size, so the cost is
 * the same whichever boxes ran first.
 */

import { mergedRuns, type Interval, type Period } from "@/lib/billing/hours";
import type { Plan } from "@/lib/billing/plans";

/** The included rate: 12¢ a vCPU-hour, $0.002 a vCPU-minute (a Small box,
 *  2 vCPU, is $0.24 an hour). */
export const INCLUDED_CENTS_PER_VCPU_HOUR = 12;
/** The overage rate: 1.5x the included rate. */
export const OVERAGE_CENTS_PER_VCPU_HOUR = 18;

/** The least a box's session costs: a box that runs (or wakes) for less is
 *  billed a minute. A session still running is billed what it has run, and
 *  gets the minimum when it ends. */
export const MIN_SESSION_MS = 60_000;

const HOUR_MS = 60 * 60_000;

/** vCPU-hours the intervals ran within `period`, up to `now`, each ended
 *  session at least MIN_SESSION_MS (which may run past now: it's owed once
 *  the session ends). Of a session crossing the period's edge, only the part
 *  inside counts. */
export function vcpuHoursUsed(intervals: readonly Interval[], period: Period, now: Date): number {
  let vcpuMs = 0;
  for (const run of mergedRuns(intervals, now)) {
    // Nothing counts from the future: not a session yet to start, nor the
    // part of one recorded as ending after now.
    if (run.start >= now.getTime()) continue;
    const ranTo = Math.min(run.end, now.getTime());
    const billedEnd = run.open ? ranTo : Math.max(ranTo, run.start + MIN_SESSION_MS);
    const start = Math.max(run.start, period.start.getTime());
    const end = Math.min(billedEnd, period.end.getTime());
    if (end > start) vcpuMs += (end - start) * run.cpu;
  }
  return vcpuMs / HOUR_MS;
}

/** What `vcpuHours` costs on a plan, in whole cents. */
export type UsageCost = {
  /** The included usage it has used, at the included rate; at most the plan's. */
  includedCents: number;
  /** Usage past the included, at the overage rate; 0 on a plan without overage. */
  overageCents: number;
  /** What it costs: included plus overage. */
  totalCents: number;
  /** Whether it has used all the plan includes. */
  includedSpent: boolean;
};

/** The cost of `vcpuHours` on `plan`: the included usage first, then
 *  overage. Rounded to cents once, here, so many short sessions don't each
 *  lose or gain a fraction of a cent. */
export function usageCost(plan: Plan, vcpuHours: number): UsageCost {
  const includedCap = plan.usage.includedUsd * 100;
  const atIncludedRate = vcpuHours * INCLUDED_CENTS_PER_VCPU_HOUR;
  const excessVcpuHours = Math.max(0, vcpuHours - includedCap / INCLUDED_CENTS_PER_VCPU_HOUR);
  const includedCents = Math.round(Math.min(atIncludedRate, includedCap));
  const overageCents = plan.usage.overage ? Math.round(excessVcpuHours * OVERAGE_CENTS_PER_VCPU_HOUR) : 0;
  return {
    includedCents,
    overageCents,
    totalCents: includedCents + overageCents,
    includedSpent: atIncludedRate >= includedCap,
  };
}

/**
 * Where an org stands, worst first:
 * - `included_spent`: a plan without overage has used all it includes (the
 *   trial's credit, a contract's hours). No box starts; running ones pause.
 *   Raising the admins' limit wouldn't help, so it comes before theirs.
 * - `at_limit`: the cost reached the limit its admins set. No box starts;
 *   running ones pause.
 * - `unpaid`: an overage payment failed. No box starts or wakes; running
 *   ones carry on.
 * - `overage`: past the included usage, billed at the overage rate.
 * - `within`: inside the included usage.
 */
export type UsageState = "included_spent" | "at_limit" | "unpaid" | "overage" | "within";

export type UsageStanding = UsageCost & {
  state: UsageState;
  /** The plan's included usage, in cents. */
  includedCapCents: number;
  /** The admins' limit, in cents; null for none. */
  limitCents: number | null;
};

export type StandingInput = {
  plan: Plan;
  cost: UsageCost;
  /** The admins' usage limit for the period, in USD; null for none. */
  limitUsd: number | null;
  /** Since when an overage payment has been failing; null while paid up. */
  unpaidSince: Date | null;
};

/** Where `cost` leaves the org: its state and the figures to show. */
export function usageStanding({ plan, cost, limitUsd, unpaidSince }: StandingInput): UsageStanding {
  const limitCents = limitUsd === null ? null : Math.round(limitUsd * 100);
  const figures = { ...cost, includedCapCents: plan.usage.includedUsd * 100, limitCents };
  if (!plan.usage.overage && cost.includedSpent) return { ...figures, state: "included_spent" };
  if (limitCents !== null && cost.totalCents >= limitCents) return { ...figures, state: "at_limit" };
  if (unpaidSince !== null) return { ...figures, state: "unpaid" };
  return { ...figures, state: cost.overageCents > 0 || cost.includedSpent ? "overage" : "within" };
}

/** Whether a box may not start (or wake) in `state`. */
export function blocksStarts(state: UsageState): boolean {
  return state === "included_spent" || state === "at_limit" || state === "unpaid";
}

/** Whether running boxes pause in `state`. */
export function pausesRunning(state: UsageState): boolean {
  return state === "included_spent" || state === "at_limit";
}

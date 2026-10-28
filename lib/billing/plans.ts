/**
 * Outrunner's plans and what each includes: the one place a limit is set.
 * Pricing and Stripe ids live in Stripe; this is what a plan lets a user do.
 * Imports nothing beyond the box sizes, so pages and tests use it as is.
 *
 * The model allowance is a dollar cap on the user's OpenRouter key
 * (lib/openrouter/keys.ts). It is never shown to users in dollars: they see
 * how much of it is used, as a percentage.
 */

import { BOX_SIZES, boxSize, type BoxSize, type BoxSizeId } from "@/lib/runtime/box-sizes";

export type PlanId = "free" | "pro" | "max" | "enterprise";

export type Plan = {
  id: PlanId;
  label: string;
  /** Hours on Outrunner's sandboxes a month, counted in Small-box hours. */
  cloudHoursPerMonth: number;
  /** Outrunner sandboxes running at once. */
  concurrentCloudSessions: number;
  /** The largest box size on Outrunner's sandboxes. */
  largestBoxSize: BoxSizeId;
  /** Spend on Outrunner's models, in USD: once ever, or each month. */
  models: { usd: number; per: "once" | "month" };
};

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    label: "Free",
    cloudHoursPerMonth: 10,
    concurrentCloudSessions: 2,
    largestBoxSize: "small",
    models: { usd: 5, per: "once" },
  },
  pro: {
    id: "pro",
    label: "Pro",
    cloudHoursPerMonth: 100,
    concurrentCloudSessions: 5,
    largestBoxSize: "medium",
    models: { usd: 10, per: "month" },
  },
  max: {
    id: "max",
    label: "Max",
    cloudHoursPerMonth: 500,
    concurrentCloudSessions: 20,
    largestBoxSize: "large",
    models: { usd: 50, per: "month" },
  },
  // Contracts set their own terms; until one needs more, Max's limits.
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    cloudHoursPerMonth: 500,
    concurrentCloudSessions: 20,
    largestBoxSize: "large",
    models: { usd: 50, per: "month" },
  },
};

/**
 * What an org's `outrunner-connector` (lib/automations/connector.ts), the
 * service user its automations run as, is entitled to: paid by the
 * deployment, not a member. Enterprise's limits, ten boxes at once, small
 * boxes, and `modelsUsd` a month on Outrunner's models
 * (AUTOMATION_MODEL_ALLOWANCE_USD). Its id stays enterprise's, as a stored
 * allowance names a plan Stripe sells.
 */
export function connectorPlan(modelsUsd: number): Plan {
  return {
    ...PLANS.enterprise,
    label: "Automations",
    concurrentCloudSessions: 10,
    largestBoxSize: "small",
    models: { usd: modelsUsd, per: "month" },
  };
}

/** The connector's monthly allowance when the deployment sets none. */
export const DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD = 50;

/** The plans Stripe sells, and how often each is billed. */
export type PaidPlanId = Exclude<PlanId, "free">;
export type BillingInterval = "month" | "year";

/** The Stripe price for each plan and interval, by its lookup key: the same
 *  keys in test and live mode, so no price id is configured anywhere. */
export const LOOKUP_KEYS: Readonly<Record<"pro" | "max", Record<BillingInterval, string>>> = {
  pro: { month: "pro_monthly", year: "pro_yearly" },
  max: { month: "max_monthly", year: "max_yearly" },
};

/** The plan a price's lookup key sells; null for one Outrunner doesn't sell. */
export function planForLookupKey(key: string | null | undefined): "pro" | "max" | null {
  for (const plan of ["pro", "max"] as const) {
    if (key === LOOKUP_KEYS[plan].month || key === LOOKUP_KEYS[plan].year) return plan;
  }
  return null;
}

/** Plans by rank, for picking the best of several. */
const RANK: Readonly<Record<PlanId, number>> = { free: 0, pro: 1, max: 2, enterprise: 3 };

/** The better of two plans. */
export function betterPlan(a: Plan, b: Plan): Plan {
  return RANK[b.id] > RANK[a.id] ? b : a;
}

/** Whether `plan` may run a box of `size` on Outrunner's sandboxes. */
export function allowsBoxSize(plan: Plan, size: BoxSizeId): boolean {
  return rank(size) <= rank(plan.largestBoxSize);
}

/** `size`, or the plan's largest when it is bigger than the plan allows. */
export function boxSizeWithin(plan: Plan, size: BoxSizeId): BoxSize {
  return allowsBoxSize(plan, size) ? boxSize(size) : boxSize(plan.largestBoxSize);
}

function rank(size: BoxSizeId): number {
  return BOX_SIZES.findIndex((s) => s.id === size);
}

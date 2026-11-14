/**
 * Outrunner's plans and what each includes: the one place a limit or price
 * is set. Stripe sells each paid plan at the price here (checkout refuses a
 * Stripe price that disagrees; lib/billing/checkout.ts), and the pages show
 * it from here, never asking Stripe. Imports nothing beyond the box sizes, so
 * pages and tests use it as is.
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
  /** Outrunner sandboxes running at once. */
  concurrentCloudSessions: number;
  /** The largest box size on Outrunner's sandboxes. */
  largestBoxSize: BoxSizeId;
  /** The longest a project's warm hook may run on a warm-pool box
   *  (lib/runtime/warm-pool.deps.ts), whose time is on the plan's usage. The
   *  sweep of abandoned refills waits past the largest of these
   *  (STALE_REFILL_MS, lib/runtime/warm-pool.ts). */
  warmHookMinutes: number;
  /** Spend on Outrunner's models, in USD: once ever, or each month; null for unlimited. */
  models: { usd: number | null; per: "once" | "month" };
  /** What the plan costs a month, in USD; null where a contract sets it. */
  priceUsd: number | null;
  /** Cloud usage the plan includes, in USD at the included rate
   *  (lib/billing/usage.ts): once ever (the trial) or each month. With
   *  `overage`, usage past it is billed at the overage rate; without, it
   *  stops there. A paid plan includes its price. */
  usage: { includedUsd: number; per: "once" | "month"; overage: boolean };
};

export const PLANS = {
  free: {
    id: "free",
    label: "Free",
    concurrentCloudSessions: 2,
    largestBoxSize: "small",
    warmHookMinutes: 15,
    models: { usd: 5, per: "once" },
    priceUsd: 0,
    usage: { includedUsd: 100, per: "once", overage: false },
  },
  pro: {
    id: "pro",
    label: "Pro",
    concurrentCloudSessions: 5,
    largestBoxSize: "medium",
    warmHookMinutes: 15,
    models: { usd: 10, per: "month" },
    priceUsd: 20,
    usage: { includedUsd: 20, per: "month", overage: true },
  },
  max: {
    id: "max",
    label: "Max",
    concurrentCloudSessions: 20,
    largestBoxSize: "large",
    warmHookMinutes: 15,
    models: { usd: 50, per: "month" },
    priceUsd: 100,
    usage: { includedUsd: 100, per: "month", overage: true },
  },
  // Contracts set their own terms; retain the default enterprise allowance.
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    concurrentCloudSessions: 50,
    largestBoxSize: "large",
    warmHookMinutes: 15,
    models: { usd: 50, per: "month" },
    // 500 Small-box hours (1,000 vCPU-hours) at the included rate.
    priceUsd: null,
    usage: { includedUsd: 120, per: "month", overage: false },
  },
} as const satisfies Readonly<Record<PlanId, Plan>>;

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

/** The plans Stripe sells. */
export type PaidPlanId = Exclude<PlanId, "free">;
/** How often a subscription is billed: monthly now; yearly on prices from
 *  before usage-based billing, until they're moved
 *  (scripts/migrate-usage-prices.ts). */
export type BillingInterval = "month" | "year";

/** The Stripe price each plan is sold at, monthly, by its lookup key: the
 *  same keys in test and live mode, so no price id is configured anywhere. */
export const LOOKUP_KEYS: Readonly<Record<"pro" | "max", string>> = {
  pro: "pro_usage_monthly",
  max: "max_usage_monthly",
};

/** The prices plans were sold at before usage-based billing: still read as
 *  their plan, so existing subscriptions keep it until they're moved. */
export const LEGACY_LOOKUP_KEYS: Readonly<Record<"pro" | "max", readonly string[]>> = {
  pro: ["pro_monthly", "pro_yearly"],
  max: ["max_monthly", "max_yearly"],
};

/** The plan a price's lookup key sells, current or legacy; null for one
 *  Outrunner doesn't sell. */
export function planForLookupKey(key: string | null | undefined): "pro" | "max" | null {
  for (const plan of ["pro", "max"] as const) {
    if (key === LOOKUP_KEYS[plan] || LEGACY_LOOKUP_KEYS[plan].includes(key ?? "")) return plan;
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

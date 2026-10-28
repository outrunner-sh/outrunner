import { subscriptionsFor } from "@/lib/billing/billing-store";
import type { Period } from "@/lib/billing/hours";
import { billingMode } from "@/lib/billing/mode";
import { isConnector } from "@/lib/automations/connector";
import { allowancePeriod, monthlyPeriod } from "@/lib/billing/periods";
import { connectorPlan, DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD, PLANS, type Plan } from "@/lib/billing/plans";
import { optionalEnv } from "@/lib/env";
import { currentSubscription, planFromSubscriptions } from "@/lib/billing/subscriptions";

export type Entitlements = {
  plan: Plan;
  /** The month the plan's allowances are in (lib/billing/periods.ts); null on
   *  Free, whose model allowance is once. */
  allowancePeriod: Period | null;
};

/**
 * What a user is entitled to now: with billing off, Free for everyone; with
 * Stripe, the best plan their subscriptions give them
 * (lib/billing/subscriptions.ts), and its period.
 */
export async function entitlementsFor(userId: string, now = new Date()): Promise<Entitlements> {
  // An org's connector, which its automations run as, billing on or off:
  // its own plan, renewed each calendar month.
  if (await isConnector(userId)) {
    return { plan: connectorPlan(automationModelAllowanceUsd()), allowancePeriod: connectorPeriod(now) };
  }
  if (billingMode() === "off") return { plan: PLANS.free, allowancePeriod: null };
  const subscriptions = await subscriptionsFor(userId);
  const plan = planFromSubscriptions(subscriptions, now);
  const subscription = currentSubscription(subscriptions, now);
  return {
    plan,
    allowancePeriod: subscription ? allowancePeriod(subscription, now) : null,
  };
}

/** The plan a user is on, which every limit is read from. */
export async function planFor(userId: string): Promise<Plan> {
  return (await entitlementsFor(userId)).plan;
}

/** The connector's allowance period: the calendar month (UTC) `now` is in. */
export function connectorPeriod(now: Date): Period {
  return monthlyPeriod(new Date(Date.UTC(2000, 0, 1)), now);
}

/** AUTOMATION_MODEL_ALLOWANCE_USD, a positive number of dollars a month;
 *  DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD otherwise. */
export function automationModelAllowanceUsd(): number {
  const value = Number(optionalEnv("AUTOMATION_MODEL_ALLOWANCE_USD"));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD;
}

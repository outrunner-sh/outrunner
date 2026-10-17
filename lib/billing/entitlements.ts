import { subscriptionsFor } from "@/lib/billing/billing-store";
import type { Period } from "@/lib/billing/hours";
import { billingMode } from "@/lib/billing/mode";
import { monthlyPeriod } from "@/lib/billing/periods";
import { PLANS, type Plan } from "@/lib/billing/plans";
import { currentSubscription, planFromSubscriptions } from "@/lib/billing/subscriptions";

export type Entitlements = {
  plan: Plan;
  /** The month the plan's allowances renew in: counted from when its
   *  subscription started; null on Free, whose model allowance is once. */
  allowancePeriod: Period | null;
};

/**
 * What a user is entitled to now: with billing off, Free for everyone; with
 * Stripe, the best plan their subscriptions give them
 * (lib/billing/subscriptions.ts), and its period.
 */
export async function entitlementsFor(userId: string, now = new Date()): Promise<Entitlements> {
  if (billingMode() === "off") return { plan: PLANS.free, allowancePeriod: null };
  const subscriptions = await subscriptionsFor(userId);
  const plan = planFromSubscriptions(subscriptions, now);
  const subscription = currentSubscription(subscriptions, now);
  return {
    plan,
    allowancePeriod: subscription ? monthlyPeriod(subscription.currentPeriodStart, now) : null,
  };
}

/** The plan a user is on, which every limit is read from. */
export async function planFor(userId: string): Promise<Plan> {
  return (await entitlementsFor(userId)).plan;
}

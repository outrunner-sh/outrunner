/**
 * Plans from subscriptions: a user's copy of their Stripe subscriptions
 * (the subscriptions table), what each says they are entitled to, and how a
 * Stripe subscription becomes a row. Pure, so the rules are tested alone.
 */

import type Stripe from "stripe";

import { betterPlan, type BillingInterval, type PaidPlanId, planForLookupKey, PLANS, type Plan } from "@/lib/billing/plans";

export type SubscriptionRecord = {
  stripeSubscriptionId: string;
  userId: string;
  stripeCustomerId: string;
  status: string;
  plan: PaidPlanId;
  priceLookupKey: string | null;
  billingInterval: BillingInterval | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  pastDueSince: Date | null;
};

/** How long a subscription whose payment failed keeps its plan, while Stripe
 *  retries the card. */
export const PAST_DUE_GRACE_MS = 3 * 24 * 60 * 60_000;

/**
 * Whether a subscription gives its plan at `now`: active or trialing; past
 * due, for the grace; nothing else (unpaid, canceled, incomplete, paused). A
 * subscription set to cancel stays active to its period's end, so it gives
 * its plan until then, and Stripe ends it after.
 */
export function entitles(subscription: SubscriptionRecord, now: Date): boolean {
  switch (subscription.status) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      return (
        subscription.pastDueSince !== null && now.getTime() - subscription.pastDueSince.getTime() < PAST_DUE_GRACE_MS
      );
    default:
      return false;
  }
}

/** The best plan any of a user's subscriptions gives them at `now`; Free when
 *  none does. */
export function planFromSubscriptions(subscriptions: readonly SubscriptionRecord[], now: Date): Plan {
  return subscriptions.filter((s) => entitles(s, now)).reduce((best, s) => betterPlan(best, PLANS[s.plan]), PLANS.free);
}

/** The subscription a user's plan comes from: the entitled one with the best
 *  plan; null on Free. */
export function currentSubscription(
  subscriptions: readonly SubscriptionRecord[],
  now: Date,
): SubscriptionRecord | null {
  const plan = planFromSubscriptions(subscriptions, now);
  return subscriptions.find((s) => entitles(s, now) && s.plan === plan.id) ?? null;
}

/**
 * The row for a subscription as Stripe reports it now. `previous` is the row
 * stored before, for when it first went past due. Null for one that sells no
 * plan of Outrunner's: a price without a known lookup key, unless it (or its
 * subscription) is marked `plan: enterprise` in its metadata.
 */
export function recordFromStripe(
  subscription: Stripe.Subscription,
  userId: string,
  previous: SubscriptionRecord | null,
  now: Date,
): SubscriptionRecord | null {
  const item = subscription.items.data[0];
  if (!item) return null;
  const price = item.price;
  const plan: PaidPlanId | null =
    subscription.metadata?.plan === "enterprise" || price.metadata?.plan === "enterprise"
      ? "enterprise"
      : planForLookupKey(price.lookup_key);
  if (!plan) return null;
  const interval: string | undefined = price.recurring?.interval;
  return {
    stripeSubscriptionId: subscription.id,
    userId,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    status: subscription.status,
    plan,
    priceLookupKey: price.lookup_key ?? null,
    billingInterval: interval === "month" || interval === "year" ? interval : null,
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    // Kept from when it first went past due, so retries don't restart the
    // grace; cleared once it isn't.
    pastDueSince: subscription.status === "past_due" ? (previous?.pastDueSince ?? now) : null,
  };
}

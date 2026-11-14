/**
 * Moving subscriptions from the prices plans were sold at before
 * usage-based billing (LEGACY_LOOKUP_KEYS) to the monthly usage prices
 * (LOOKUP_KEYS). Pure, for scripts/migrate-usage-prices.ts and the tests.
 *
 * - A monthly one moves to the new price with no proration: the change shows
 *   on its next renewal invoice, so the month already paid is left alone.
 * - A yearly one moves now, to monthly: Stripe credits the unused part of
 *   the year against the first month (the rest to the customer's balance, which
 *   pays the invoices after), so no one loses what they paid for.
 */

import { LEGACY_LOOKUP_KEYS, LOOKUP_KEYS } from "@/lib/billing/plans";
import { stillBills } from "@/lib/billing/subscriptions";

/** A Stripe subscription as the move reads it. */
export type SubscriptionPrice = {
  id: string;
  status: string;
  /** Its one item, whose price moves. */
  itemId: string;
  lookupKey: string | null;
  interval: string | null;
  /** Set to end at its period's close: it lapses on its own. */
  cancelAtPeriodEnd: boolean;
};

export type PriceMove = {
  subscriptionId: string;
  itemId: string;
  plan: "pro" | "max";
  toLookupKey: string;
  /** Stripe's proration_behavior: "none" (monthly: from the next renewal) or
   *  "always_invoice" (yearly: now, with the unused year credited). */
  proration: "none" | "always_invoice";
};

/** How `subscription` moves; null for one that needn't (on a new price
 *  already, a price Outrunner doesn't sell, past billing, or set to cancel:
 *  moving a yearly one would re-anchor it and end it a month out, the rest
 *  of its year left as credit it can never spend). */
export function priceMoveFor(subscription: SubscriptionPrice): PriceMove | null {
  if (!stillBills(subscription.status) || subscription.cancelAtPeriodEnd) return null;
  const plan = (["pro", "max"] as const).find((p) => LEGACY_LOOKUP_KEYS[p].includes(subscription.lookupKey ?? ""));
  if (!plan) return null;
  return {
    subscriptionId: subscription.id,
    itemId: subscription.itemId,
    plan,
    toLookupKey: LOOKUP_KEYS[plan],
    proration: subscription.interval === "year" ? "always_invoice" : "none",
  };
}

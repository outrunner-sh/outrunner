/**
 * Sending a user to Stripe: Checkout to start a plan, the customer portal to
 * change or cancel one. Both on Stripe's own pages; nothing about a card
 * touches Outrunner. The I/O is behind {@link CheckoutDeps}.
 */

import { type BillingInterval, LOOKUP_KEYS } from "@/lib/billing/plans";
import { stillBills } from "@/lib/billing/subscriptions";

export type CheckoutUser = { id: string; githubLogin: string; email: string | null };

export type CheckoutDeps = {
  customerIdFor(userId: string): Promise<string | null>;
  claimCustomer(userId: string, customerId: string): Promise<string>;
  /** A new Stripe customer for `user`; the same one for a retry with the
   *  same idempotency key. */
  createCustomer(user: CheckoutUser, idempotencyKey: string): Promise<string>;
  /** The statuses of the customer's subscriptions, as Stripe has them now:
   *  every one, including any Outrunner doesn't store (a price it doesn't
   *  sell, one made in Stripe's dashboard). */
  subscriptionStatuses(customerId: string): Promise<string[]>;
  priceIdFor(lookupKey: string): Promise<string>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    userId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  createPortalSession(customerId: string, returnUrl: string): Promise<string>;
  /** Expire the customer's checkouts still open, so none of them can be paid. */
  expireOpenCheckouts(customerId: string): Promise<void>;
};

/** Where the billing page is, which Stripe sends users back to. */
export const BILLING_PATH = "/settings/billing";

/**
 * The user's Stripe customer, made the first time. Two first checkouts at
 * once make one: they ask Stripe with the same idempotency key, and the
 * database keeps the first stored.
 */
export async function ensureCustomer(user: CheckoutUser, deps: CheckoutDeps): Promise<string> {
  const stored = await deps.customerIdFor(user.id);
  if (stored) return stored;
  const created = await deps.createCustomer(user, `outrunner-customer-${user.id}`);
  return deps.claimCustomer(user.id, created);
}

/**
 * Where to send a user who asked for `plan`: Checkout, or the portal if any
 * subscription Stripe holds for them can still bill (stillBills), to change
 * or fix it there rather than pay twice. Asked of Stripe, not the stored
 * copy, which leaves out subscriptions to prices Outrunner doesn't sell. A
 * new checkout expires any older one still open, so two tabs can't each
 * start a subscription.
 */
export async function checkoutDestination(
  user: CheckoutUser,
  plan: "pro" | "max",
  interval: BillingInterval,
  baseUrl: string,
  deps: CheckoutDeps,
): Promise<{ url: string; kind: "checkout" | "portal" }> {
  const customerId = await ensureCustomer(user, deps);
  const billing = new URL(BILLING_PATH, baseUrl).toString();
  if ((await deps.subscriptionStatuses(customerId)).some(stillBills)) {
    return { url: await deps.createPortalSession(customerId, billing), kind: "portal" };
  }
  const priceId = await deps.priceIdFor(LOOKUP_KEYS[plan][interval]);
  await deps.expireOpenCheckouts(customerId);
  const url = await deps.createCheckoutSession({
    customerId,
    priceId,
    userId: user.id,
    // Stripe fills in {CHECKOUT_SESSION_ID}; braces are kept as they are.
    successUrl: `${billing}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${billing}?checkout=canceled`,
  });
  return { url, kind: "checkout" };
}

/** The plan and interval a link asks for (`?plan=pro|max&interval=month|year`):
 *  null plan for one Outrunner doesn't sell; monthly unless it says yearly. */
export function requestedPlan(params: URLSearchParams): { plan: "pro" | "max" | null; interval: BillingInterval } {
  const plan = params.get("plan");
  return {
    plan: plan === "pro" || plan === "max" ? plan : null,
    interval: params.get("interval") === "year" ? "year" : "month",
  };
}

/** The customer portal, to manage a plan; null for a user with no customer. */
export async function portalDestination(userId: string, baseUrl: string, deps: CheckoutDeps): Promise<string | null> {
  const customerId = await deps.customerIdFor(userId);
  if (!customerId) return null;
  return deps.createPortalSession(customerId, new URL(BILLING_PATH, baseUrl).toString());
}

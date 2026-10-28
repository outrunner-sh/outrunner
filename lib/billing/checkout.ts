/**
 * Sending an org's admin to Stripe: Checkout to start the org's plan, the
 * customer portal to change or cancel it (billing is the org's). Both on Stripe's own pages; nothing about a card
 * touches Outrunner. The I/O is behind {@link CheckoutDeps}.
 */

import { type BillingInterval, LOOKUP_KEYS } from "@/lib/billing/plans";
import { stillBills } from "@/lib/billing/subscriptions";

/** The org a plan is bought for, and the admin buying it. */
export type CheckoutBuyer = {
  orgId: string;
  orgName: string;
  userId: string;
  githubLogin: string;
  email: string | null;
};

export type CheckoutDeps = {
  customerIdFor(orgId: string): Promise<string | null>;
  claimCustomer(orgId: string, userId: string, customerId: string): Promise<string>;
  /** A new Stripe customer for the buyer's org; the same one for a retry
   *  with the same idempotency key. */
  createCustomer(buyer: CheckoutBuyer, idempotencyKey: string): Promise<string>;
  /** The statuses of the customer's subscriptions, as Stripe has them now:
   *  every one, including any Outrunner doesn't store (a price it doesn't
   *  sell, one made in Stripe's dashboard). */
  subscriptionStatuses(customerId: string): Promise<string[]>;
  priceIdFor(lookupKey: string): Promise<string>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    orgId: string;
    userId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  createPortalSession(customerId: string, returnUrl: string): Promise<string>;
  /** Expire the customer's checkouts still open, so none of them can be paid. */
  expireOpenCheckouts(customerId: string): Promise<void>;
};

/** Where the billing page is, which Stripe sends users back to unless told
 *  otherwise. */
export const BILLING_PATH = "/settings/billing";

/**
 * The org's Stripe customer, made the first time. Two first checkouts at
 * once make one: they ask Stripe with the same idempotency key, and the
 * database keeps the first stored. A user's from before orgs is their
 * personal org's.
 */
export async function ensureCustomer(buyer: CheckoutBuyer, deps: CheckoutDeps): Promise<string> {
  const stored = await deps.customerIdFor(buyer.orgId);
  if (stored) return stored;
  const created = await deps.createCustomer(buyer, `outrunner-org-customer-${buyer.orgId}`);
  return deps.claimCustomer(buyer.orgId, buyer.userId, created);
}

/**
 * Where to send an admin who asked for `plan` for their org: Checkout, or the
 * portal if any subscription Stripe holds for the org can still bill (stillBills), to change
 * or fix it there rather than pay twice. Asked of Stripe, not the stored
 * copy, which leaves out subscriptions to prices Outrunner doesn't sell. A
 * new checkout expires any older one still open, so two tabs can't each
 * start a subscription. Stripe sends the user back to `returnPath`: Billing,
 * or onboarding for a new user who bought from a link.
 */
export async function checkoutDestination(
  buyer: CheckoutBuyer,
  plan: "pro" | "max",
  interval: BillingInterval,
  baseUrl: string,
  deps: CheckoutDeps,
  returnPath: string = BILLING_PATH,
): Promise<{ url: string; kind: "checkout" | "portal" }> {
  const customerId = await ensureCustomer(buyer, deps);
  const back = new URL(returnPath, baseUrl).toString();
  if ((await deps.subscriptionStatuses(customerId)).some(stillBills)) {
    return { url: await deps.createPortalSession(customerId, back), kind: "portal" };
  }
  const priceId = await deps.priceIdFor(LOOKUP_KEYS[plan][interval]);
  await deps.expireOpenCheckouts(customerId);
  const url = await deps.createCheckoutSession({
    customerId,
    priceId,
    orgId: buyer.orgId,
    userId: buyer.userId,
    // Stripe fills in {CHECKOUT_SESSION_ID}; braces are kept as they are.
    successUrl: `${back}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${back}?checkout=canceled`,
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

/** The customer portal, to manage the org's plan; null for an org with no
 *  customer. */
export async function portalDestination(orgId: string, baseUrl: string, deps: CheckoutDeps): Promise<string | null> {
  const customerId = await deps.customerIdFor(orgId);
  if (!customerId) return null;
  return deps.createPortalSession(customerId, new URL(BILLING_PATH, baseUrl).toString());
}

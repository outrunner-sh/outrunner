/** Production wiring of the Stripe billing logic: Stripe's API and the
 *  billing tables. */

import {
  claimCustomer,
  customerIdFor,
  deleteSubscription,
  eventHandled,
  recordEvent,
  saveSubscription,
  subscriptionById,
  userForCustomer,
} from "@/lib/billing/billing-store";
import type { CheckoutDeps } from "@/lib/billing/checkout";
import { refreshModelAllowance } from "@/lib/db/credentials";
import { LOOKUP_KEYS } from "@/lib/billing/plans";
import { stripe } from "@/lib/billing/stripe";
import type { SyncDeps } from "@/lib/billing/sync";

export const syncDeps: SyncDeps = {
  retrieveSubscription: (id) => stripe().subscriptions.retrieve(id),
  userForCustomer,
  subscriptionById,
  saveSubscription,
  deleteSubscription,
  eventHandled,
  recordEvent,
  now: () => new Date(),
  log: (message) => console.warn(message),
  // An upgrade's allowance applies at once, not at the next session.
  changed: async (userId) => void (await refreshModelAllowance(userId)),
};

export const checkoutDeps: CheckoutDeps = {
  customerIdFor,
  claimCustomer,
  createCustomer: async (user, idempotencyKey) => {
    const customer = await stripe().customers.create(
      {
        // The GitHub login is how support finds a user in Stripe's dashboard.
        name: user.githubLogin || undefined,
        email: user.email ?? undefined,
        metadata: { user_id: user.id, github_login: user.githubLogin },
      },
      { idempotencyKey },
    );
    return customer.id;
  },
  subscriptionStatuses: async (customerId) => {
    const statuses: string[] = [];
    for await (const subscription of stripe().subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
      statuses.push(subscription.status);
    }
    return statuses;
  },
  priceIdFor: async (lookupKey) => {
    const prices = await stripe().prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) throw new Error(`No active Stripe price has the lookup key ${lookupKey}.`);
    return price.id;
  },
  createCheckoutSession: async ({ customerId, priceId, userId, successUrl, cancelUrl }) => {
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      // So the webhook can tell whose it is even before the customer is
      // stored (lib/billing/sync.ts).
      subscription_data: { metadata: { user_id: userId } },
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    if (!session.url) throw new Error("Stripe made a checkout session with no URL.");
    return session.url;
  },
  createPortalSession: async (customerId, returnUrl) =>
    (await stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url,
  expireOpenCheckouts: async (customerId) => {
    for await (const session of stripe().checkout.sessions.list({ customer: customerId, status: "open", limit: 100 })) {
      await stripe().checkout.sessions.expire(session.id);
    }
  },
};

/** How long to wait for Stripe's prices before going without them. The pages
 *  that show them render around the answer, so a slow Stripe must not hold
 *  them: the SDK waits 80 seconds and retries twice by default, long enough
 *  to look like a hang. A price lookup changes nothing, and both callers show
 *  their page without prices, so it is not worth retrying either. */
const PRICES_TIMEOUT_MS = 5000;

/** What Stripe charges for each plan and interval, in USD, by lookup key:
 *  shown on the billing page and onboarding's plans step, so prices live in
 *  Stripe alone. Rejects rather than wait past PRICES_TIMEOUT_MS. */
export async function listedPricesUsd(): Promise<Record<string, number>> {
  const keys = Object.values(LOOKUP_KEYS).flatMap((byInterval) => Object.values(byInterval));
  const prices = await stripe().prices.list(
    { lookup_keys: keys, active: true, limit: keys.length },
    { timeout: PRICES_TIMEOUT_MS, maxNetworkRetries: 0 },
  );
  return Object.fromEntries(
    prices.data.flatMap((price) =>
      price.lookup_key && price.unit_amount !== null ? [[price.lookup_key, price.unit_amount / 100]] : [],
    ),
  );
}

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

/** What Stripe charges for each plan and interval, in USD, by lookup key:
 *  shown on the billing page, so prices live in Stripe alone. */
export async function listedPricesUsd(): Promise<Record<string, number>> {
  const keys = Object.values(LOOKUP_KEYS).flatMap((byInterval) => Object.values(byInterval));
  const prices = await stripe().prices.list({ lookup_keys: keys, active: true, limit: keys.length });
  return Object.fromEntries(
    prices.data.flatMap((price) =>
      price.lookup_key && price.unit_amount !== null ? [[price.lookup_key, price.unit_amount / 100]] : [],
    ),
  );
}

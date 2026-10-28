/** Production wiring of the Stripe billing logic: Stripe's API and the
 *  billing tables. */

import { recordAudit } from "@/lib/audit/record";
import {
  claimCustomer,
  customerIdFor,
  deleteSubscription,
  eventHandled,
  recordEvent,
  orgForCustomer,
  saveSubscription,
  subscriptionById,
} from "@/lib/billing/billing-store";
import type { CheckoutDeps } from "@/lib/billing/checkout";
import { refreshModelAllowance } from "@/lib/db/credentials";
import { refreshOrgModelAllowance } from "@/lib/db/org-model-allowance";
import { getOrg, personalOrgId, personalOwners } from "@/lib/db/orgs";
import { LOOKUP_KEYS, PLANS } from "@/lib/billing/plans";
import { stripe } from "@/lib/billing/stripe";
import type { SyncDeps } from "@/lib/billing/sync";

export const syncDeps: SyncDeps = {
  retrieveSubscription: (id) => stripe().subscriptions.retrieve(id),
  orgForCustomer,
  personalOrgOf: personalOrgId,
  subscriptionById,
  // Stored, and said in the org's audit log when its plan or status moved.
  async saveSubscription(record, fetchedAt) {
    // Only for the log: a failed read counts as a change, never fails the save.
    const previous = await subscriptionById(record.stripeSubscriptionId).catch(() => undefined);
    const stored = await saveSubscription(record, fetchedAt);
    if (stored && (previous?.plan !== record.plan || previous?.status !== record.status)) {
      await recordAudit({
        orgId: record.orgId,
        actor: "system",
        action: "billing.plan_changed",
        resource: { type: "subscription", id: record.stripeSubscriptionId, label: PLANS[record.plan].label },
        details: { status: record.status, interval: record.billingInterval },
      });
    }
    return stored;
  },
  deleteSubscription,
  eventHandled,
  recordEvent,
  now: () => new Date(),
  log: (message) => console.warn(message),
  // An upgrade's allowance applies at once, not at the next session: a
  // personal org's plan sets its owner's model key; a team org's, its own.
  changed: async (orgId) => {
    const owner = (await personalOwners([orgId])).get(orgId);
    if (owner) await refreshModelAllowance(owner);
    else await refreshOrgModelAllowance(orgId);
  },
};

export const checkoutDeps: CheckoutDeps = {
  customerIdFor,
  claimCustomer,
  createCustomer: async (buyer, idempotencyKey) => {
    const personal = (await getOrg(buyer.orgId))?.personal ?? true;
    const customer = await stripe().customers.create(
      {
        // The GitHub login is how support finds a solo user in Stripe's
        // dashboard; a team org by its name.
        name: (personal ? buyer.githubLogin : buyer.orgName) || undefined,
        email: buyer.email ?? undefined,
        metadata: { org_id: buyer.orgId, user_id: buyer.userId, github_login: buyer.githubLogin },
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
  createCheckoutSession: async ({ customerId, priceId, orgId, userId, successUrl, cancelUrl }) => {
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: orgId,
      // So the webhook can tell whose it is even before the customer is
      // stored (lib/billing/sync.ts); and who bought it.
      subscription_data: { metadata: { org_id: orgId, user_id: userId } },
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

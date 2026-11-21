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
  setOverageUnpaid,
  subscriptionById,
} from "@/lib/billing/billing-store";
import { OVERAGE_KIND } from "@/lib/billing/overage";
import type { CheckoutDeps } from "@/lib/billing/checkout";
import { refreshModelAllowance } from "@/lib/db/credentials";
import { refreshOrgModelAllowance } from "@/lib/db/org-model-allowance";
import { ownOrgId } from "@/lib/db/orgs";
import { PLANS } from "@/lib/billing/plans";
import { stripe } from "@/lib/billing/stripe";
import type { SyncDeps } from "@/lib/billing/sync";

export const syncDeps: SyncDeps = {
  retrieveSubscription: (id) => stripe().subscriptions.retrieve(id),
  orgForCustomer,
  ownOrgOf: ownOrgId,
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
  // An upgrade's allowance applies at once, not at the next session: an
  // org's plan sets its own model key.
  changed: async (orgId) => {
    await refreshOrgModelAllowance(orgId);
  },
  async openOverageInvoices(customerId) {
    const open: { created: Date; attempted: boolean }[] = [];
    for await (const invoice of stripe().invoices.list({ customer: customerId, status: "open", limit: 100 })) {
      if (invoice.metadata?.kind === OVERAGE_KIND) {
        open.push({ created: new Date(invoice.created * 1000), attempted: invoice.attempt_count > 0 });
      }
    }
    return open;
  },
  setOverageUnpaid,
};

export const checkoutDeps: CheckoutDeps = {
  customerIdFor,
  claimCustomer,
  createCustomer: async (buyer, idempotencyKey) => {
    const customer = await stripe().customers.create(
      {
        // The org's name, as support finds it in Stripe's dashboard; its
        // buyer's GitHub login is in the metadata.
        name: buyer.orgName || buyer.githubLogin || undefined,
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
  priceFor: async (lookupKey) => {
    const prices = await stripe().prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) throw new Error(`No active Stripe price has the lookup key ${lookupKey}.`);
    return { id: price.id, unitAmountCents: price.unit_amount, currency: price.currency };
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

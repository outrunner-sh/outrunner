/**
 * Keeping the copy of orgs' subscriptions true to Stripe, from its webhook
 * events. An event is only a cue: the subscription it concerns is fetched
 * from Stripe and stored whole, so events arriving out of order or twice
 * can't leave an older state behind. The I/O is behind {@link SyncDeps}.
 */

import type Stripe from "stripe";

import { OVERAGE_KIND, unpaidSinceOf } from "@/lib/billing/overage";
import { recordFromStripe, type SubscriptionRecord } from "@/lib/billing/subscriptions";

export type SyncDeps = {
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  orgForCustomer(customerId: string): Promise<string | null>;
  /** A user's personal org: a subscription from before billing was the
   *  org's names only its buyer. */
  personalOrgOf(userId: string): Promise<string | null>;
  subscriptionById(id: string): Promise<SubscriptionRecord | null>;
  /** Store it as fetched at `fetchedAt`, unless a later fetch is stored;
   *  true when stored. */
  saveSubscription(record: SubscriptionRecord, fetchedAt: Date): Promise<boolean>;
  deleteSubscription(id: string): Promise<void>;
  eventHandled(id: string): Promise<boolean>;
  recordEvent(id: string, type: string): Promise<void>;
  now(): Date;
  log(message: string): void;
  /** An org's subscriptions changed: its allowances may have moved. */
  changed?(orgId: string): Promise<void>;
  /** The customer's open overage invoices (lib/billing/overage.ts): when
   *  each was made, and whether its payment has been tried. */
  openOverageInvoices(customerId: string): Promise<{ created: Date; attempted: boolean }[]>;
  /** Record since when the org's overage has been unpaid; null once paid. */
  setOverageUnpaid(orgId: string, since: Date | null): Promise<void>;
};

/** The subscription an event concerns, or null for one that concerns none. */
export function subscriptionIdOf(event: Stripe.Event): string | null {
  const object = event.data.object as unknown as Record<string, unknown>;
  switch (event.type) {
    case "checkout.session.completed":
      return idOf((object as unknown as Stripe.Checkout.Session).subscription);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return (object as unknown as Stripe.Subscription).id;
    case "invoice.paid":
    case "invoice.payment_failed":
      return idOf((object as unknown as Stripe.Invoice).parent?.subscription_details?.subscription);
    default:
      return null;
  }
}

/**
 * Fetch subscription `id` from Stripe and store it. Null, storing nothing,
 * for one that isn't a known org's; one that no longer sells a plan of
 * Outrunner's is forgotten, so it grants nothing.
 */
export async function syncSubscription(id: string, deps: SyncDeps): Promise<SubscriptionRecord | null> {
  // Taken before the fetch: a save only lands over an older fetch, so of two
  // webhooks racing, the one that asked Stripe later wins.
  const fetchedAt = deps.now();
  const subscription = await deps.retrieveSubscription(id);
  const customerId = idOf(subscription.customer);
  const previous = await deps.subscriptionById(id);
  // The customer Outrunner made for the org is the authority; the org id
  // checkout put in the metadata is a fallback, for a customer stored late,
  // and one from before orgs names its buyer, whose personal org it is.
  const metadata = subscription.metadata ?? {};
  const buyer = metadata.user_id || previous?.userId || null;
  const orgId =
    (customerId && (await deps.orgForCustomer(customerId))) ||
    metadata.org_id ||
    previous?.orgId ||
    (buyer ? await deps.personalOrgOf(buyer) : null);
  if (!orgId) {
    deps.log(`Stripe subscription ${id} is for customer ${customerId}, who is no Outrunner org; not stored`);
    return null;
  }
  const record = recordFromStripe(subscription, { orgId, userId: buyer }, previous, fetchedAt);
  if (!record) {
    deps.log(`Stripe subscription ${id} sells no plan Outrunner knows (no known lookup key); forgotten`);
    await deps.deleteSubscription(id);
    await refreshAllowances(orgId, id, deps);
    return null;
  }
  if (!(await deps.saveSubscription(record, fetchedAt))) return null;
  await refreshAllowances(orgId, id, deps);
  return record;
}

/** Bring the org's allowances in line with what changed. A failure isn't a
 *  reason to have Stripe deliver the event again: the allowance is brought in
 *  line again whenever a member next starts a session. */
async function refreshAllowances(orgId: string, subscriptionId: string, deps: SyncDeps): Promise<void> {
  await deps.changed?.(orgId).catch((error: unknown) =>
    deps.log(`Could not refresh org ${orgId}'s allowances after subscription ${subscriptionId}: ${String(error)}`),
  );
}

/** The events that can change whether an org's overage is paid: a payment
 *  failing or going through, or the invoice voided or written off. */
const OVERAGE_INVOICE_EVENTS = new Set(["invoice.paid", "invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible"]);

/** The overage invoice an event is about (lib/billing/overage.ts), or null. */
export function overageInvoiceOf(event: Stripe.Event): Stripe.Invoice | null {
  if (!OVERAGE_INVOICE_EVENTS.has(event.type)) return null;
  const invoice = event.data.object as Stripe.Invoice;
  return invoice.metadata?.kind === OVERAGE_KIND ? invoice : null;
}

/**
 * Bring the org's unpaid overage in line with Stripe: unpaid since its
 * earliest open overage invoice whose payment was tried, or paid once none
 * is. Read from Stripe rather than from the one event, so a payment that
 * clears one invoice while another still fails keeps the org unpaid.
 */
async function syncOverageUnpaid(invoice: Stripe.Invoice, deps: SyncDeps): Promise<void> {
  const customerId = idOf(invoice.customer);
  if (!customerId) return;
  const orgId = (await deps.orgForCustomer(customerId)) || invoice.metadata?.org_id || null;
  if (!orgId) {
    deps.log(`Stripe overage invoice ${invoice.id} is for customer ${customerId}, who is no Outrunner org`);
    return;
  }
  await deps.setOverageUnpaid(orgId, unpaidSinceOf(await deps.openOverageInvoices(customerId)));
}

export type EventOutcome = "synced" | "duplicate" | "ignored";

/** Handle one verified webhook event. Recorded as handled only once it has
 *  been, so a failure throws and Stripe delivers it again. */
export async function handleEvent(event: Stripe.Event, deps: SyncDeps): Promise<EventOutcome> {
  if (await deps.eventHandled(event.id)) return "duplicate";
  if (event.type === "charge.dispute.created") {
    // A dispute doesn't end a subscription by itself; someone looks at it.
    deps.log(`Stripe dispute on charge ${idOf((event.data.object as Stripe.Dispute).charge)}: review it in Stripe`);
  }
  const subscriptionId = subscriptionIdOf(event);
  if (subscriptionId) await syncSubscription(subscriptionId, deps);
  const overage = overageInvoiceOf(event);
  if (overage) await syncOverageUnpaid(overage, deps);
  await deps.recordEvent(event.id, event.type);
  return subscriptionId || overage ? "synced" : "ignored";
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

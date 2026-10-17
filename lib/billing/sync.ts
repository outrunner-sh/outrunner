/**
 * Keeping the copy of users' subscriptions true to Stripe, from its webhook
 * events. An event is only a cue: the subscription it concerns is fetched
 * from Stripe and stored whole, so events arriving out of order or twice
 * can't leave an older state behind. The I/O is behind {@link SyncDeps}.
 */

import type Stripe from "stripe";

import { recordFromStripe, type SubscriptionRecord } from "@/lib/billing/subscriptions";

export type SyncDeps = {
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  userForCustomer(customerId: string): Promise<string | null>;
  subscriptionById(id: string): Promise<SubscriptionRecord | null>;
  /** Store it as fetched at `fetchedAt`, unless a later fetch is stored;
   *  true when stored. */
  saveSubscription(record: SubscriptionRecord, fetchedAt: Date): Promise<boolean>;
  deleteSubscription(id: string): Promise<void>;
  eventHandled(id: string): Promise<boolean>;
  recordEvent(id: string, type: string): Promise<void>;
  now(): Date;
  log(message: string): void;
};

/** The events whose subscription is synced; the rest are acknowledged and
 *  left. */
export const SYNCED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

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
 * for one that isn't a known user's; one that no longer sells a plan of
 * Outrunner's is forgotten, so it grants nothing.
 */
export async function syncSubscription(id: string, deps: SyncDeps): Promise<SubscriptionRecord | null> {
  // Taken before the fetch: a save only lands over an older fetch, so of two
  // webhooks racing, the one that asked Stripe later wins.
  const fetchedAt = deps.now();
  const subscription = await deps.retrieveSubscription(id);
  const customerId = idOf(subscription.customer);
  // The customer Outrunner made for the user is the authority; the user id
  // checkout put in the metadata is a fallback, for a customer stored late.
  const userId = (customerId && (await deps.userForCustomer(customerId))) || subscription.metadata?.user_id || null;
  if (!userId) {
    deps.log(`Stripe subscription ${id} is for customer ${customerId}, who is no Outrunner user; not stored`);
    return null;
  }
  const record = recordFromStripe(subscription, userId, await deps.subscriptionById(id), fetchedAt);
  if (!record) {
    deps.log(`Stripe subscription ${id} sells no plan Outrunner knows (no known lookup key); forgotten`);
    await deps.deleteSubscription(id);
    return null;
  }
  if (!(await deps.saveSubscription(record, fetchedAt))) return null;
  return record;
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
  await deps.recordEvent(event.id, event.type);
  return subscriptionId ? "synced" : "ignored";
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

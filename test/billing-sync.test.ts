import assert from "node:assert/strict";
import { test } from "node:test";

import Stripe from "stripe";

import type { SubscriptionRecord } from "@/lib/billing/subscriptions";
import { handleEvent, subscriptionIdOf, type SyncDeps } from "@/lib/billing/sync";

const NOW = new Date("2026-10-17T12:00:00Z");

function stripeSubscription(status: string, opts: { customer?: string; metadata?: Record<string, string> } = {}) {
  return {
    id: "sub_1",
    customer: opts.customer ?? "cus_1",
    status,
    cancel_at_period_end: false,
    metadata: opts.metadata ?? {},
    items: {
      data: [
        {
          current_period_start: Date.parse("2026-10-01T00:00:00Z") / 1000,
          current_period_end: Date.parse("2026-11-01T00:00:00Z") / 1000,
          price: { lookup_key: "pro_monthly", metadata: {}, recurring: { interval: "month" } },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function event(type: string, object: object, id = "evt_1"): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

/** Stripe holding `subscription` now; the database knowing `customers`. */
function world(subscription: Stripe.Subscription, customers: Record<string, string> = { cus_1: "u-1" }) {
  const saved: SubscriptionRecord[] = [];
  const handled = new Set<string>();
  const logs: string[] = [];
  let retrieves = 0;
  const deps: SyncDeps = {
    retrieveSubscription: async () => {
      retrieves += 1;
      return subscription;
    },
    userForCustomer: async (id) => customers[id] ?? null,
    subscriptionById: async (id) => saved.findLast((r) => r.stripeSubscriptionId === id) ?? null,
    saveSubscription: async (r) => void saved.push(r),
    eventHandled: async (id) => handled.has(id),
    recordEvent: async (id) => void handled.add(id),
    now: () => NOW,
    log: (m) => void logs.push(m),
  };
  return { deps, saved, handled, logs, retrieves: () => retrieves };
}

test("each synced event finds its subscription where Stripe puts it", () => {
  assert.equal(subscriptionIdOf(event("checkout.session.completed", { subscription: "sub_9" })), "sub_9");
  assert.equal(subscriptionIdOf(event("customer.subscription.deleted", { id: "sub_9" })), "sub_9");
  assert.equal(
    subscriptionIdOf(event("invoice.payment_failed", { parent: { subscription_details: { subscription: "sub_9" } } })),
    "sub_9",
  );
  assert.equal(subscriptionIdOf(event("invoice.paid", { parent: null })), null, "a one-off invoice");
  assert.equal(subscriptionIdOf(event("checkout.session.completed", { subscription: null })), null);
  assert.equal(subscriptionIdOf(event("customer.created", { id: "cus_1" })), null);
});

test("an event is a cue: the subscription is fetched and stored as Stripe has it now", async () => {
  // A stale "updated" saying active arrives after the subscription was
  // deleted: what's stored is Stripe's current state, canceled.
  const w = world(stripeSubscription("canceled"));
  const outcome = await handleEvent(event("customer.subscription.updated", { id: "sub_1", status: "active" }), w.deps);
  assert.equal(outcome, "synced");
  assert.equal(w.saved.at(-1)?.status, "canceled");
  assert.equal(w.saved.at(-1)?.userId, "u-1");
});

test("an event delivered twice is handled once", async () => {
  const w = world(stripeSubscription("active"));
  await handleEvent(event("invoice.paid", { parent: { subscription_details: { subscription: "sub_1" } } }), w.deps);
  const again = await handleEvent(event("invoice.paid", { parent: { subscription_details: { subscription: "sub_1" } } }), w.deps);
  assert.equal(again, "duplicate");
  assert.equal(w.retrieves(), 1);
});

test("a failure leaves the event unrecorded, so Stripe's retry handles it", async () => {
  const w = world(stripeSubscription("active"));
  w.deps.saveSubscription = async () => {
    throw new Error("database down");
  };
  await assert.rejects(handleEvent(event("customer.subscription.created", { id: "sub_1" }), w.deps), /database down/);
  assert.equal(w.handled.has("evt_1"), false);
});

test("the stored customer decides whose a subscription is; checkout's metadata only fills in", async () => {
  // Metadata naming someone else doesn't move a subscription to them.
  const w = world(stripeSubscription("active", { metadata: { user_id: "u-other" } }));
  await handleEvent(event("customer.subscription.created", { id: "sub_1" }), w.deps);
  assert.equal(w.saved.at(-1)?.userId, "u-1");
  // A customer not stored yet (the webhook beat checkout's write): metadata.
  const early = world(stripeSubscription("active", { customer: "cus_new", metadata: { user_id: "u-2" } }), {});
  await handleEvent(event("customer.subscription.created", { id: "sub_1" }), early.deps);
  assert.equal(early.saved.at(-1)?.userId, "u-2");
});

test("a subscription that's no Outrunner user's is logged and acknowledged, not stored", async () => {
  const w = world(stripeSubscription("active", { customer: "cus_stranger" }), {});
  assert.equal(await handleEvent(event("customer.subscription.created", { id: "sub_1" }), w.deps), "synced");
  assert.equal(w.saved.length, 0);
  assert.match(w.logs[0], /no Outrunner user/);
  assert.equal(w.handled.has("evt_1"), true, "acknowledged, so Stripe stops retrying");
});

test("a dispute is logged for someone to review; the subscription is left alone", async () => {
  const w = world(stripeSubscription("active"));
  assert.equal(await handleEvent(event("charge.dispute.created", { charge: "ch_1" }), w.deps), "ignored");
  assert.match(w.logs[0], /dispute on charge ch_1/);
  assert.equal(w.saved.length, 0);
});

test("only a correctly signed, recent payload is accepted as Stripe's", () => {
  const stripe = new Stripe("sk_test_unused");
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(stripe.webhooks.constructEvent(payload, header, secret).id, "evt_1");
  assert.throws(() => stripe.webhooks.constructEvent(payload.replace("evt_1", "evt_2"), header, secret));
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, "whsec_other"));
  const old = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.throws(() => stripe.webhooks.constructEvent(payload, old, secret), /timestamp/i);
});

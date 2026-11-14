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
function world(subscription: Stripe.Subscription, customers: Record<string, string> = { cus_1: "o-1" }) {
  const saved: SubscriptionRecord[] = [];
  const deleted: string[] = [];
  const handled = new Set<string>();
  const logs: string[] = [];
  const unpaid: Array<[string, Date | null]> = [];
  let openOverage: { created: Date; attempted: boolean }[] = [];
  let retrieves = 0;
  const deps: SyncDeps = {
    retrieveSubscription: async () => {
      retrieves += 1;
      return subscription;
    },
    orgForCustomer: async (id) => customers[id] ?? null,
    personalOrgOf: async (userId) => `personal-${userId}`,
    subscriptionById: async (id) => saved.findLast((r) => r.stripeSubscriptionId === id) ?? null,
    saveSubscription: async (r) => {
      saved.push(r);
      return true;
    },
    deleteSubscription: async (id) => void deleted.push(id),
    eventHandled: async (id) => handled.has(id),
    recordEvent: async (id) => void handled.add(id),
    now: () => NOW,
    log: (m) => void logs.push(m),
    openOverageInvoices: async () => openOverage,
    setOverageUnpaid: async (orgId, since) => void unpaid.push([orgId, since]),
  };
  return {
    deps,
    saved,
    deleted,
    handled,
    logs,
    unpaid,
    setOpenOverage: (invoices: typeof openOverage) => void (openOverage = invoices),
    retrieves: () => retrieves,
  };
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
  assert.equal(w.saved.at(-1)?.orgId, "o-1");
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

test("the stored customer decides whose org a subscription is; checkout's metadata only fills in", async () => {
  // Metadata naming another org doesn't move a subscription to it.
  const w = world(stripeSubscription("active", { metadata: { org_id: "o-other", user_id: "u-1" } }));
  await handleEvent(event("customer.subscription.created", { id: "sub_1" }), w.deps);
  assert.equal(w.saved.at(-1)?.orgId, "o-1");
  assert.equal(w.saved.at(-1)?.userId, "u-1");
  // A customer not stored yet (the webhook beat checkout's write): metadata.
  const early = world(stripeSubscription("active", { customer: "cus_new", metadata: { org_id: "o-2", user_id: "u-2" } }), {});
  await handleEvent(event("customer.subscription.created", { id: "sub_1" }), early.deps);
  assert.equal(early.saved.at(-1)?.orgId, "o-2");
  // One from before billing was the org's names only its buyer: theirs is
  // their personal org's.
  const before = world(stripeSubscription("active", { customer: "cus_old", metadata: { user_id: "u-3" } }), {});
  await handleEvent(event("customer.subscription.created", { id: "sub_1" }), before.deps);
  assert.equal(before.saved.at(-1)?.orgId, "personal-u-3");
});

test("a subscription that's no Outrunner org's is logged and acknowledged, not stored", async () => {
  const w = world(stripeSubscription("active", { customer: "cus_stranger" }), {});
  w.deps.personalOrgOf = async () => null;
  assert.equal(await handleEvent(event("customer.subscription.created", { id: "sub_1" }), w.deps), "synced");
  assert.equal(w.saved.length, 0);
  assert.match(w.logs[0], /no Outrunner org/);
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

test("a save asks to land only over an older fetch, timed before asking Stripe", async () => {
  const w = world(stripeSubscription("canceled"));
  const asked: Date[] = [];
  let clock = NOW.getTime();
  w.deps.now = () => new Date((clock += 1000));
  w.deps.retrieveSubscription = async () => {
    asked.push(new Date(clock));
    return stripeSubscription("canceled");
  };
  let fetchedAt: Date | null = null;
  w.deps.saveSubscription = async (_r, at) => {
    fetchedAt = at;
    return false; // a later fetch is stored already
  };
  const refreshed: string[] = [];
  w.deps.changed = async (userId) => void refreshed.push(userId);
  await handleEvent(event("customer.subscription.updated", { id: "sub_1" }), w.deps);
  assert.ok(fetchedAt! <= asked[0], "the fetch is timed before Stripe is asked, never after");
  assert.deepEqual(refreshed, [], "nothing stored, nothing to refresh");
});

test("a subscription moved to a price Outrunner doesn't sell is forgotten, so it grants nothing", async () => {
  const unknown = stripeSubscription("active");
  (unknown.items.data[0].price as { lookup_key: string | null }).lookup_key = "legacy_plan";
  const w = world(unknown);
  const refreshed: string[] = [];
  w.deps.changed = async (userId) => void refreshed.push(userId);
  await handleEvent(event("customer.subscription.updated", { id: "sub_1" }), w.deps);
  assert.deepEqual(w.deleted, ["sub_1"]);
  assert.equal(w.saved.length, 0);
  assert.deepEqual(refreshed, ["o-1"], "its plan is gone: the allowance follows");
});

test("a stored subscription refreshes the org's allowances; a failure there doesn't fail the event", async () => {
  const w = world(stripeSubscription("active"));
  const refreshed: string[] = [];
  w.deps.changed = async (userId) => {
    refreshed.push(userId);
    throw new Error("OpenRouter down");
  };
  assert.equal(await handleEvent(event("customer.subscription.updated", { id: "sub_1" }), w.deps), "synced");
  assert.deepEqual(refreshed, ["o-1"]);
  assert.match(w.logs[0], /Could not refresh org o-1's allowances/);
  assert.equal(w.handled.has("evt_1"), true);
});

test("an overage invoice's payment marks the org unpaid or paid, as Stripe's open overage invoices say", async () => {
  const overage = (id: string, metadata: Record<string, string> = { kind: "overage", org_id: "o-1" }, customer = "cus_1") =>
    ({ id, customer, metadata, parent: null }) as unknown as Stripe.Invoice;
  const failedAt = new Date("2026-11-15T00:00:00Z");

  const failed = world(stripeSubscription("active"));
  failed.setOpenOverage([{ created: failedAt, attempted: true }]);
  assert.equal(await handleEvent(event("invoice.payment_failed", overage("in_1")), failed.deps), "synced");
  assert.deepEqual(failed.unpaid, [["o-1", failedAt]]);
  assert.equal(failed.retrieves(), 0);

  // Paid, or voided or written off, with none left open: paid up.
  for (const type of ["invoice.paid", "invoice.voided", "invoice.marked_uncollectible"]) {
    const paid = world(stripeSubscription("active"));
    paid.setOpenOverage([]);
    await handleEvent(event(type, overage("in_1")), paid.deps);
    assert.deepEqual(paid.unpaid, [["o-1", null]], type);
  }

  // One paid while another still fails: still unpaid.
  const partly = world(stripeSubscription("active"));
  partly.setOpenOverage([{ created: failedAt, attempted: true }]);
  await handleEvent(event("invoice.paid", overage("in_2")), partly.deps);
  assert.deepEqual(partly.unpaid, [["o-1", failedAt]]);

  // A customer stored late: the org from the invoice's metadata.
  const late = world(stripeSubscription("active"), {});
  await handleEvent(event("invoice.payment_failed", overage("in_3", { kind: "overage", org_id: "o-9" }, "cus_new")), late.deps);
  assert.deepEqual(late.unpaid, [["o-9", null]]);

  // Not an overage invoice, or another event: unpaid isn't touched.
  const other = world(stripeSubscription("active"));
  await handleEvent(event("invoice.payment_failed", overage("in_4", {})), other.deps);
  await handleEvent(event("invoice.created", overage("in_5"), "evt_2"), other.deps);
  assert.deepEqual(other.unpaid, []);
});

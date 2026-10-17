import assert from "node:assert/strict";
import { test } from "node:test";

import type Stripe from "stripe";

import {
  currentSubscription,
  entitles,
  PAST_DUE_GRACE_MS,
  planFromSubscriptions,
  recordFromStripe,
  type SubscriptionRecord,
} from "@/lib/billing/subscriptions";

const NOW = new Date("2026-10-17T12:00:00Z");

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    stripeSubscriptionId: "sub_1",
    userId: "u-1",
    stripeCustomerId: "cus_1",
    status: "active",
    plan: "pro",
    priceLookupKey: "pro_monthly",
    billingInterval: "month",
    currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    ...overrides,
  };
}

/** A Stripe subscription as the API returns it, in the fields Outrunner reads. */
function stripeSubscription(overrides: {
  status?: string;
  lookupKey?: string | null;
  interval?: string;
  metadata?: Record<string, string>;
  priceMetadata?: Record<string, string>;
  cancelAtPeriodEnd?: boolean;
} = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: overrides.status ?? "active",
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    metadata: overrides.metadata ?? {},
    items: {
      data: [
        {
          current_period_start: Date.parse("2026-10-01T00:00:00Z") / 1000,
          current_period_end: Date.parse("2026-11-01T00:00:00Z") / 1000,
          price: {
            lookup_key: overrides.lookupKey === undefined ? "max_yearly" : overrides.lookupKey,
            metadata: overrides.priceMetadata ?? {},
            recurring: { interval: overrides.interval ?? "year" },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

test("active and trialing give their plan; ended, unpaid, incomplete and paused don't", () => {
  for (const status of ["active", "trialing"]) assert.equal(entitles(record({ status }), NOW), true, status);
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "something_new"]) {
    assert.equal(entitles(record({ status }), NOW), false, status);
  }
});

test("a failed payment keeps the plan for 3 days while Stripe retries, then it lapses", () => {
  const pastDue = (ms: number) => record({ status: "past_due", pastDueSince: new Date(NOW.getTime() - ms) });
  assert.equal(entitles(pastDue(PAST_DUE_GRACE_MS - 60_000), NOW), true);
  assert.equal(entitles(pastDue(PAST_DUE_GRACE_MS), NOW), false);
  assert.equal(entitles(record({ status: "past_due", pastDueSince: null }), NOW), false);
});

test("a plan set to cancel stays until Stripe ends it", () => {
  assert.equal(entitles(record({ cancelAtPeriodEnd: true }), NOW), true);
});

test("the user gets the best plan any subscription gives, and Free with none", () => {
  assert.equal(planFromSubscriptions([], NOW).id, "free");
  assert.equal(planFromSubscriptions([record({ status: "canceled", plan: "max" })], NOW).id, "free");
  const both = [record({ plan: "pro" }), record({ stripeSubscriptionId: "sub_2", plan: "max" })];
  assert.equal(planFromSubscriptions(both, NOW).id, "max");
  assert.equal(currentSubscription(both, NOW)?.stripeSubscriptionId, "sub_2");
  assert.equal(currentSubscription([], NOW), null);
});

test("a Stripe subscription becomes a row: plan by lookup key, period from its item", () => {
  assert.deepEqual(recordFromStripe(stripeSubscription(), "u-1", null, NOW), {
    stripeSubscriptionId: "sub_1",
    userId: "u-1",
    stripeCustomerId: "cus_1",
    status: "active",
    plan: "max",
    priceLookupKey: "max_yearly",
    billingInterval: "year",
    currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    pastDueSince: null,
  });
});

test("a price Outrunner doesn't sell is no plan, unless it's marked enterprise", () => {
  assert.equal(recordFromStripe(stripeSubscription({ lookupKey: "other" }), "u-1", null, NOW), null);
  assert.equal(recordFromStripe(stripeSubscription({ lookupKey: null }), "u-1", null, NOW), null);
  const contract = recordFromStripe(stripeSubscription({ lookupKey: null, metadata: { plan: "enterprise" } }), "u-1", null, NOW);
  assert.equal(contract?.plan, "enterprise");
  const byPrice = recordFromStripe(stripeSubscription({ lookupKey: null, priceMetadata: { plan: "enterprise" } }), "u-1", null, NOW);
  assert.equal(byPrice?.plan, "enterprise");
});

test("going past due starts the grace once; Stripe's retries don't restart it, and paying clears it", () => {
  const first = recordFromStripe(stripeSubscription({ status: "past_due" }), "u-1", null, NOW);
  assert.deepEqual(first?.pastDueSince, NOW);
  const later = new Date(NOW.getTime() + 86_400_000);
  const retry = recordFromStripe(stripeSubscription({ status: "past_due" }), "u-1", first, later);
  assert.deepEqual(retry?.pastDueSince, NOW);
  const paid = recordFromStripe(stripeSubscription({ status: "active" }), "u-1", retry, later);
  assert.equal(paid?.pastDueSince, null);
});

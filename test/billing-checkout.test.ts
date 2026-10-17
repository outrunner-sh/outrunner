import assert from "node:assert/strict";
import { test } from "node:test";

import { type CheckoutDeps, checkoutDestination, ensureCustomer, portalDestination } from "@/lib/billing/checkout";
import type { SubscriptionRecord } from "@/lib/billing/subscriptions";

const NOW = new Date("2026-10-17T12:00:00Z");
const user = { id: "u-1", githubLogin: "octo", email: null };
const BASE = "https://outrunner.neev.ai";

function deps(opts: { stored?: string; subscriptions?: SubscriptionRecord[] } = {}) {
  let stored: string | null = opts.stored ?? null;
  const calls: string[] = [];
  const d: CheckoutDeps = {
    customerIdFor: async () => stored,
    claimCustomer: async (_u, id) => {
      stored ??= id;
      return stored;
    },
    createCustomer: async (_u, key) => {
      calls.push(`create customer ${key}`);
      return "cus_new";
    },
    subscriptionsFor: async () => opts.subscriptions ?? [],
    priceIdFor: async (key) => `price_${key}`,
    createCheckoutSession: async (input) => {
      calls.push(`checkout ${input.customerId} ${input.priceId} ${input.successUrl} ${input.cancelUrl}`);
      return "https://checkout.stripe.com/c/pay/1";
    },
    createPortalSession: async (customer, returnUrl) => {
      calls.push(`portal ${customer} ${returnUrl}`);
      return "https://billing.stripe.com/p/session/1";
    },
    now: () => NOW,
  };
  return { d, calls, stored: () => stored };
}

test("a first checkout makes the user's customer once, by user id", async () => {
  const { d, calls } = deps();
  assert.equal(await ensureCustomer(user, d), "cus_new");
  assert.deepEqual(calls, ["create customer outrunner-customer-u-1"]);
  // Stored: the next checkout reuses it.
  assert.equal(await ensureCustomer(user, d), "cus_new");
  assert.equal(calls.length, 1);
});

test("two first checkouts at once keep the customer stored first", async () => {
  const { d } = deps({ stored: "cus_first" });
  d.customerIdFor = async () => null; // both saw none stored...
  assert.equal(await ensureCustomer(user, d), "cus_first"); // ...the claim keeps the first
});

test("a Free user goes to Checkout for the plan and interval asked, and back to Billing", async () => {
  const { d, calls } = deps({ stored: "cus_1" });
  const destination = await checkoutDestination(user, "max", "year", BASE, d);
  assert.deepEqual(destination, { url: "https://checkout.stripe.com/c/pay/1", kind: "checkout" });
  assert.deepEqual(calls, [
    "checkout cus_1 price_max_yearly " +
      `${BASE}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID} ` +
      `${BASE}/settings/billing?checkout=canceled`,
  ]);
});

test("a user with a paid plan goes to the portal to change it, never a second checkout", async () => {
  const pro: SubscriptionRecord = {
    stripeSubscriptionId: "sub_1",
    userId: "u-1",
    stripeCustomerId: "cus_1",
    status: "active",
    plan: "pro",
    priceLookupKey: "pro_monthly",
    billingInterval: "month",
    currentPeriodStart: NOW,
    currentPeriodEnd: NOW,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
  };
  const { d, calls } = deps({ stored: "cus_1", subscriptions: [pro] });
  assert.equal((await checkoutDestination(user, "max", "month", BASE, d)).kind, "portal");
  assert.deepEqual(calls, [`portal cus_1 ${BASE}/settings/billing`]);
  // One that has lapsed checks out again.
  const lapsed = deps({ stored: "cus_1", subscriptions: [{ ...pro, status: "canceled" }] });
  assert.equal((await checkoutDestination(user, "pro", "month", BASE, lapsed.d)).kind, "checkout");
});

test("the portal needs a customer", async () => {
  assert.equal(await portalDestination("u-1", BASE, deps().d), null);
  assert.equal(await portalDestination("u-1", BASE, deps({ stored: "cus_1" }).d), "https://billing.stripe.com/p/session/1");
});

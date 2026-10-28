import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CheckoutDeps,
  checkoutDestination,
  ensureCustomer,
  portalDestination,
  requestedPlan,
} from "@/lib/billing/checkout";
import type { SubscriptionRecord } from "@/lib/billing/subscriptions";

const NOW = new Date("2026-10-17T12:00:00Z");
const user = { orgId: "o-1", orgName: "octo", userId: "u-1", githubLogin: "octo", email: null };
const BASE = "https://app.outrunner.sh";

function deps(opts: { stored?: string; subscriptions?: SubscriptionRecord[] } = {}) {
  let stored: string | null = opts.stored ?? null;
  const calls: string[] = [];
  const d: CheckoutDeps = {
    customerIdFor: async () => stored,
    claimCustomer: async (_o, _u, id) => {
      stored ??= id;
      return stored;
    },
    createCustomer: async (_u, key) => {
      calls.push(`create customer ${key}`);
      return "cus_new";
    },
    subscriptionStatuses: async () => (opts.subscriptions ?? []).map((s) => s.status),
    priceIdFor: async (key) => `price_${key}`,
    createCheckoutSession: async (input) => {
      calls.push(`checkout ${input.customerId} ${input.priceId} ${input.successUrl} ${input.cancelUrl}`);
      return "https://checkout.stripe.com/c/pay/1";
    },
    createPortalSession: async (customer, returnUrl) => {
      calls.push(`portal ${customer} ${returnUrl}`);
      return "https://billing.stripe.com/p/session/1";
    },
    expireOpenCheckouts: async (customer) => void calls.push(`expire open checkouts of ${customer}`),
  };
  return { d, calls, stored: () => stored };
}

test("a first checkout makes the org's customer once, by org id", async () => {
  const { d, calls } = deps();
  assert.equal(await ensureCustomer(user, d), "cus_new");
  assert.deepEqual(calls, ["create customer outrunner-org-customer-o-1"]);
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
    // An older checkout in another tab can no longer be paid.
    "expire open checkouts of cus_1",
    "checkout cus_1 price_max_yearly " +
      `${BASE}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID} ` +
      `${BASE}/settings/billing?checkout=canceled`,
  ]);
});

test("a new user from a pricing link goes back to onboarding, paid or not", async () => {
  const { d, calls } = deps({ stored: "cus_1" });
  await checkoutDestination(user, "pro", "month", BASE, d, "/onboarding");
  assert.equal(
    calls.at(-1),
    "checkout cus_1 price_pro_monthly " +
      `${BASE}/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID} ` +
      `${BASE}/onboarding?checkout=canceled`,
  );
});

test("a user with a subscription that can still bill goes to the portal, never a second checkout", async () => {
  const pro: SubscriptionRecord = {
    stripeSubscriptionId: "sub_1",
    orgId: "o-1",
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
  // One whose payment failed past the grace can still bill: the portal, to fix it.
  for (const status of ["past_due", "unpaid", "paused"]) {
    const failing = deps({ stored: "cus_1", subscriptions: [{ ...pro, status, pastDueSince: new Date(0) }] });
    assert.equal((await checkoutDestination(user, "pro", "month", BASE, failing.d)).kind, "portal", status);
  }
  // One Outrunner doesn't store (a price it doesn't sell) still counts:
  // Stripe is asked, not the stored copy.
  const unstored = deps({ stored: "cus_1" });
  unstored.d.subscriptionStatuses = async () => ["active"];
  assert.equal((await checkoutDestination(user, "pro", "month", BASE, unstored.d)).kind, "portal");
  // One that has ended, or never started, checks out again.
  for (const status of ["canceled", "incomplete_expired", "incomplete"]) {
    const lapsed = deps({ stored: "cus_1", subscriptions: [{ ...pro, status }] });
    assert.equal((await checkoutDestination(user, "pro", "month", BASE, lapsed.d)).kind, "checkout", status);
  }
});

test("the portal needs a customer", async () => {
  assert.equal(await portalDestination("o-1", BASE, deps().d), null);
  assert.equal(await portalDestination("o-1", BASE, deps({ stored: "cus_1" }).d), "https://billing.stripe.com/p/session/1");
});

test("a link asks for a plan Outrunner sells, monthly unless it says yearly", () => {
  const ask = (query: string) => requestedPlan(new URLSearchParams(query));
  assert.deepEqual(ask("plan=pro"), { plan: "pro", interval: "month" });
  assert.deepEqual(ask("plan=max&interval=year"), { plan: "max", interval: "year" });
  assert.deepEqual(ask("plan=enterprise&interval=year"), { plan: null, interval: "year" });
  assert.deepEqual(ask("plan=PRO&interval=weekly"), { plan: null, interval: "month" });
  assert.deepEqual(ask(""), { plan: null, interval: "month" });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { dueForRenewal } from "@/lib/billing/allowance-renewal";
import type { SubscriptionRecord } from "@/lib/billing/subscriptions";

const NOW = new Date("2026-03-20T12:00:00Z");

function yearly(userId: string, overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    stripeSubscriptionId: `sub_${userId}`,
    orgId: `org-${userId}`,
    userId,
    stripeCustomerId: `cus_${userId}`,
    status: "active",
    plan: "pro",
    priceLookupKey: "pro_yearly",
    billingInterval: "year",
    currentPeriodStart: new Date("2026-01-17T00:00:00Z"),
    currentPeriodEnd: new Date("2027-01-17T00:00:00Z"),
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    ...overrides,
  };
}

test("a yearly plan's new month is due; one already renewed, or with no key, isn't", () => {
  const march = "2026-03-17T00:00:00.000Z";
  const stored = new Map<string, string | null>([
    ["u-feb", "2026-02-17T00:00:00.000Z"], // last month's: due
    ["u-mar", march], // this month's: renewed
    ["u-new", null], // a key, no period stored yet: due
  ]);
  const subs = ["u-feb", "u-mar", "u-new", "u-nokey"].map((u) => yearly(u));
  assert.deepEqual(dueForRenewal(subs, (s) => s.userId, stored, NOW).sort(), ["u-feb", "u-new"]);
});

test("a subscription that no longer gives its plan renews nothing", () => {
  const stored = new Map<string, string | null>([["u-1", "2026-02-17T00:00:00.000Z"]]);
  const lapsed = yearly("u-1", { status: "past_due", pastDueSince: new Date("2026-03-01T00:00:00Z") });
  assert.deepEqual(dueForRenewal([lapsed], (s) => s.userId, stored, NOW), []);
});

test("Max keys are reconciled even within the current period so existing caps are removed", () => {
  const subscription = yearly("u-max", { plan: "max", priceLookupKey: "max_yearly" });
  const stored = new Map([["u-max", "2026-03-17T00:00:00.000Z"]]);
  assert.deepEqual(dueForRenewal([subscription], (s) => s.userId, stored, NOW), ["u-max"]);
});

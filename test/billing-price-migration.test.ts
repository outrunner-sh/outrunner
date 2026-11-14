import assert from "node:assert/strict";
import { test } from "node:test";

import { planForLookupKey } from "@/lib/billing/plans";
import { priceMoveFor, type SubscriptionPrice } from "@/lib/billing/price-migration";

const sub = (over: Partial<SubscriptionPrice>): SubscriptionPrice => ({
  id: "sub_1",
  status: "active",
  itemId: "si_1",
  lookupKey: "pro_monthly",
  interval: "month",
  ...over,
});

test("new and legacy prices both read as their plan, until legacy ones are moved", () => {
  const cases: Array<[string | null, "pro" | "max" | null]> = [
    ["pro_usage_monthly", "pro"],
    ["max_usage_monthly", "max"],
    ["pro_monthly", "pro"],
    ["pro_yearly", "pro"],
    ["max_monthly", "max"],
    ["max_yearly", "max"],
    ["enterprise", null],
    ["", null],
    [null, null],
  ];
  for (const [key, plan] of cases) assert.equal(planForLookupKey(key), plan, String(key));
});

test("monthly legacy prices move from the next renewal; yearly ones now, with the unused year credited", () => {
  const cases: Array<[string, Partial<SubscriptionPrice>, ReturnType<typeof priceMoveFor>]> = [
    ["monthly Pro", {}, { subscriptionId: "sub_1", itemId: "si_1", plan: "pro", toLookupKey: "pro_usage_monthly", proration: "none" }],
    ["yearly Max", { lookupKey: "max_yearly", interval: "year" }, { subscriptionId: "sub_1", itemId: "si_1", plan: "max", toLookupKey: "max_usage_monthly", proration: "always_invoice" }],
    ["past due still bills, so it moves", { status: "past_due" }, { subscriptionId: "sub_1", itemId: "si_1", plan: "pro", toLookupKey: "pro_usage_monthly", proration: "none" }],
    ["already on the new price", { lookupKey: "pro_usage_monthly" }, null],
    ["canceled", { status: "canceled" }, null],
    ["a price Outrunner doesn't sell", { lookupKey: "enterprise_custom" }, null],
  ];
  for (const [what, over, move] of cases) assert.deepEqual(priceMoveFor(sub(over)), move, what);
});

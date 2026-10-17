import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { planFor } from "@/lib/billing/entitlements";
import { BillingConfigError, billingMode } from "@/lib/billing/mode";
import { allowsBoxSize, boxSizeWithin, PLANS } from "@/lib/billing/plans";

test("billing is off by default outside production, and must be said in production", () => {
  assert.equal(billingMode({}), "off");
  assert.equal(billingMode({ NODE_ENV: "development" }), "off");
  assert.equal(billingMode({ NODE_ENV: "production", RUNTIME_BILLING: "off" }), "off");
  assert.equal(billingMode({ NODE_ENV: "production", RUNTIME_BILLING: " off " }), "off");
  assert.throws(() => billingMode({ NODE_ENV: "production" }), BillingConfigError);
  assert.throws(() => billingMode({ NODE_ENV: "production", RUNTIME_BILLING: "  " }), BillingConfigError);
});

test("a billing setting this build can't honour is refused, not guessed at", () => {
  assert.throws(() => billingMode({ RUNTIME_BILLING: "stripe" }), /isn't supported by this build/);
  assert.throws(() => billingMode({ RUNTIME_BILLING: "Off" }), /Invalid RUNTIME_BILLING "Off"/);
  assert.throws(() => billingMode({ RUNTIME_BILLING: "true" }), BillingConfigError);
});

const savedBilling = process.env.RUNTIME_BILLING;
afterEach(() => {
  if (savedBilling === undefined) delete process.env.RUNTIME_BILLING;
  else process.env.RUNTIME_BILLING = savedBilling;
});

test("with billing off everyone is on Free", async () => {
  process.env.RUNTIME_BILLING = "off";
  assert.equal((await planFor("u-1")).id, "free");
});

test("Max is 5× Pro, and each paid plan includes more than the one below", () => {
  const { free, pro, max } = PLANS;
  assert.equal(max.cloudHoursPerMonth, 5 * pro.cloudHoursPerMonth);
  assert.equal(max.models.usd, 5 * pro.models.usd);
  assert.ok(pro.cloudHoursPerMonth > free.cloudHoursPerMonth);
  assert.ok(pro.concurrentCloudSessions > free.concurrentCloudSessions);
  assert.ok(max.concurrentCloudSessions > pro.concurrentCloudSessions);
  // Free's model allowance is a one-time trial; paid ones renew.
  assert.equal(free.models.per, "once");
  assert.equal(pro.models.per, "month");
  assert.equal(max.models.per, "month");
});

test("a plan allows its largest box size and every smaller one", () => {
  const allowed = (plan: keyof typeof PLANS) =>
    (["x-small", "small", "medium", "large"] as const).filter((size) => allowsBoxSize(PLANS[plan], size));
  assert.deepEqual(allowed("free"), ["x-small", "small"]);
  assert.deepEqual(allowed("pro"), ["x-small", "small", "medium"]);
  assert.deepEqual(allowed("max"), ["x-small", "small", "medium", "large"]);
  assert.equal(boxSizeWithin(PLANS.pro, "large").id, "medium");
  assert.equal(boxSizeWithin(PLANS.pro, "x-small").id, "x-small");
});

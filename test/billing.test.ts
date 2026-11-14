import assert from "node:assert/strict";
import { test } from "node:test";

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

test("Stripe billing needs both its keys, and a setting it can't read is refused", () => {
  const keys = { STRIPE_SECRET_KEY: "rk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
  assert.equal(billingMode({ NODE_ENV: "production", RUNTIME_BILLING: "stripe", ...keys }), "stripe");
  assert.throws(() => billingMode({ RUNTIME_BILLING: "stripe" }), /needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET/);
  assert.throws(
    () => billingMode({ RUNTIME_BILLING: "stripe", STRIPE_SECRET_KEY: "rk_test_x", STRIPE_WEBHOOK_SECRET: " " }),
    /needs STRIPE_WEBHOOK_SECRET\./,
  );
  assert.throws(() => billingMode({ RUNTIME_BILLING: "Off" }), /Invalid RUNTIME_BILLING "Off"/);
  assert.throws(() => billingMode({ RUNTIME_BILLING: "true" }), BillingConfigError);
});

test("Max has unlimited cloud hours, and each paid plan includes more than the one below", () => {
  const { free, pro, max } = PLANS;
  assert.equal(max.cloudHoursPerMonth, null);
  assert.equal(max.models.usd, null);
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

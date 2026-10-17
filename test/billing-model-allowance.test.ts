import assert from "node:assert/strict";
import { test } from "node:test";

import { type AllowanceState, allowanceWithin, nextAllowance, ONCE } from "@/lib/billing/model-allowance";
import { PLANS } from "@/lib/billing/plans";

const october = { start: new Date("2026-10-17T00:00:00Z"), end: new Date("2026-11-17T00:00:00Z") };
const november = { start: new Date("2026-11-17T00:00:00Z"), end: new Date("2026-12-17T00:00:00Z") };
const free = { plan: PLANS.free, allowancePeriod: null };
const pro = (period = october) => ({ plan: PLANS.pro, allowancePeriod: period });
const max = (period = october) => ({ plan: PLANS.max, allowancePeriod: period });

test("Free is its allowance once over the key's life, and is set once", () => {
  const first = nextAllowance(free, null, 2);
  assert.deepEqual(first, { period: ONCE, plan: "free", baselineUsd: 0, limitUsd: 5 });
  assert.equal(nextAllowance(free, first, 4.5), null, "using it doesn't move the cap");
  assert.deepEqual(allowanceWithin(first!, 2), { usedUsd: 2, limitUsd: 5 });
});

test("subscribing starts a period: the cap is what's spent plus the plan's allowance", () => {
  const onFree = nextAllowance(free, null, 3)!;
  const subscribed = nextAllowance(pro(), onFree, 3);
  assert.deepEqual(subscribed, { period: october.start.toISOString(), plan: "pro", baselineUsd: 3, limitUsd: 13 });
  assert.deepEqual(allowanceWithin(subscribed!, 3), { usedUsd: 0, limitUsd: 10 }, "a period starts at 0%");
  assert.equal(nextAllowance(pro(), subscribed, 12), null, "within the period nothing moves");
});

test("each new period renews the allowance from what's spent, unused allowance not carried over", () => {
  const oct = nextAllowance(pro(), null, 0)!;
  const nov = nextAllowance(pro(november), oct, 4);
  assert.deepEqual(nov, { period: november.start.toISOString(), plan: "pro", baselineUsd: 4, limitUsd: 14 });
});

test("an upgrade mid-period adds the difference, keeping what this period has used", () => {
  const onPro = nextAllowance(pro(), null, 0)!;
  const onMax = nextAllowance(max(), onPro, 7);
  // $7 of Pro's $10 used; Max allows $50 this period: $43 left.
  assert.deepEqual(onMax, { period: october.start.toISOString(), plan: "max", baselineUsd: 0, limitUsd: 50 });
});

test("a downgrade mid-period never sets the cap below what's spent", () => {
  const onMax = nextAllowance(max(), null, 0)!;
  assert.equal(nextAllowance(pro(), onMax, 30)?.limitUsd, 30);
});

test("back on Free after paying, nothing more is free", () => {
  const onPro = nextAllowance(pro(), null, 40)!;
  const lapsed = nextAllowance(free, onPro, 48);
  assert.deepEqual(lapsed, { period: ONCE, plan: "free", baselineUsd: 43, limitUsd: 48 });
  assert.deepEqual(allowanceWithin(lapsed!, 48), { usedUsd: 5, limitUsd: 5 }, "shown as used up");
});

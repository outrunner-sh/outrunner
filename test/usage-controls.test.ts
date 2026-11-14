import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorPlan, type Plan, PLANS } from "@/lib/billing/plans";
import { usageCost, usageStanding } from "@/lib/billing/usage";
import { alertsDue, limitFor, MAX_LIMIT_USD, postedLimitUsd, thresholdsFor, type UsageControls } from "@/lib/billing/usage-controls";

const controls = (limitUsd: number | null, alertThresholds: UsageControls["alertThresholds"] = []): UsageControls => ({ limitUsd, alertThresholds });

test("a limit applies only on a plan with overage, and never below what the plan includes", () => {
  assert.equal(limitFor(PLANS.pro, controls(30)), 30);
  assert.equal(limitFor(PLANS.pro, controls(null)), null);
  // Saved on Pro, then upgraded to Max: Max's $100 is paid for, so it holds until raised.
  assert.equal(limitFor(PLANS.max, controls(30)), 100);
  for (const plan of [PLANS.free, PLANS.enterprise, connectorPlan(50)]) assert.equal(limitFor(plan, controls(500)), null, plan.label);
});

test("a posted limit is whole cents, from the included usage to the typo guard, on a plan that takes one", () => {
  const cases: Array<[unknown, Plan, number | null | undefined]> = [
    [null, PLANS.pro, null],
    [20, PLANS.pro, 20],
    [30.5, PLANS.pro, 30.5],
    [19.99, PLANS.pro, undefined],
    [99, PLANS.max, undefined],
    [30.555, PLANS.pro, undefined],
    [MAX_LIMIT_USD, PLANS.pro, MAX_LIMIT_USD],
    [MAX_LIMIT_USD + 1, PLANS.pro, undefined],
    ["30", PLANS.pro, undefined],
    [Number.NaN, PLANS.pro, undefined],
    [Number.POSITIVE_INFINITY, PLANS.pro, undefined],
    [50, PLANS.free, undefined],
    [null, PLANS.free, null],
  ];
  for (const [value, plan, expected] of cases) assert.equal(postedLimitUsd(value, plan), expected, `${String(value)} on ${plan.label}`);
});

test("alerts are shares of the included usage, past 100% only where usage can go past it", () => {
  assert.deepEqual(thresholdsFor(PLANS.pro), [50, 80, 100, 150, 200]);
  assert.deepEqual(thresholdsFor(PLANS.free), [50, 80, 100]);
  const all = controls(null, [200, 50, 150, 80, 100]);
  const pro = (vcpuHours: number) => usageStanding({ plan: PLANS.pro, cost: usageCost(PLANS.pro, vcpuHours), limitUsd: null, unpaidSince: null });
  // $20 included: 80 vCPU-hours is $9.60 (48%), 150 is $18 (90%).
  assert.deepEqual(alertsDue(PLANS.pro, pro(80), all, new Set()), []);
  assert.deepEqual(alertsDue(PLANS.pro, pro(150), all, new Set()), [50, 80]);
  assert.deepEqual(alertsDue(PLANS.pro, pro(150), all, new Set([50])), [80]);
  // $36: $20 included + 88.9 vCPU-hours past it at 18¢ = $16 of overage: 180%.
  const over = pro(166.667 + 88.889);
  assert.equal(over.totalCents, 3600);
  assert.deepEqual(alertsDue(PLANS.pro, over, all, new Set([50, 80])), [100, 150]);
  // The trial can't pass 100%: a 150% alert saved on a paid plan never fires on it.
  const trial = usageStanding({ plan: PLANS.free, cost: usageCost(PLANS.free, 1000), limitUsd: null, unpaidSince: null });
  assert.deepEqual(alertsDue(PLANS.free, trial, all, new Set()), [50, 80, 100]);
});

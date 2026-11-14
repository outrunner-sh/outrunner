import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANS } from "@/lib/billing/plans";
import { alertsDue, hoursCap, limitDenial, overLimit, postedLimit } from "@/lib/billing/usage-controls";

const pro = PLANS.pro; // 100 hours

test("a limit is a share of the plan's hours; none is all of them", () => {
  assert.equal(hoursCap(pro, { limitPercent: 80, alertThresholds: [] }), 80);
  assert.equal(hoursCap(pro, { limitPercent: null, alertThresholds: [] }), 100);
});

test("past the admins' limit no box starts; the plan's own limit is the plan's to say", () => {
  const controls = { limitPercent: 80, alertThresholds: [] };
  assert.equal(overLimit(pro, controls, 79.9), false);
  assert.equal(overLimit(pro, controls, 80), true);
  assert.match(limitDenial(pro, controls, 80)?.error ?? "", /80% of its plan's 100 cloud hours/);
  // 100% is the plan's own cap: hoursDenial says that one.
  assert.equal(overLimit(pro, { limitPercent: 100, alertThresholds: [] }, 120), false);
  assert.equal(overLimit(pro, { limitPercent: null, alertThresholds: [] }, 120), false);
});

test("each alert crossed and not yet sent is due, lowest first", () => {
  const controls = { limitPercent: null, alertThresholds: [100, 50, 80] as (50 | 80 | 100)[] };
  assert.deepEqual(alertsDue(pro, controls, 49, new Set()), []);
  assert.deepEqual(alertsDue(pro, controls, 85, new Set()), [50, 80]);
  assert.deepEqual(alertsDue(pro, controls, 85, new Set([50])), [80]);
  assert.deepEqual(alertsDue(pro, controls, 100, new Set([50, 80])), [100]);
});

test("a posted limit is a whole percent from 10 to 100, or none", () => {
  assert.equal(postedLimit(null), null);
  assert.equal(postedLimit(50), 50);
  assert.equal(postedLimit(5), undefined);
  assert.equal(postedLimit(50.5), undefined);
  assert.equal(postedLimit("50"), undefined);
});

test("unlimited hours ignore saved percentage caps and threshold alerts", () => {
  for (const limitPercent of [null, 25, 80, 100]) {
    const controls = { limitPercent, alertThresholds: [50, 80, 100] as const };
    const saved = {
      ...controls,
      alertThresholds: [...controls.alertThresholds],
    };
    assert.equal(hoursCap(PLANS.max, saved), null);
    assert.equal(limitDenial(PLANS.max, saved, 100000), null);
    assert.deepEqual(alertsDue(PLANS.max, saved, 100000, new Set()), []);
  }
});

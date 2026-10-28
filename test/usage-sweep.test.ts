import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANS } from "@/lib/billing/plans";
import type { UsageControls } from "@/lib/billing/usage-controls";
import { sweepOrgUsage, type UsageSweepDeps } from "@/lib/billing/usage-sweep";

const period = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

function world(used: number, controls: UsageControls, sent = new Set<number>()) {
  const emailed: number[] = [];
  const paused: string[] = [];
  const claimed = new Set(sent);
  const deps: UsageSweepDeps = {
    busyOrgs: async () => ["o-1"],
    controls: async () => controls,
    entitlements: async () => ({ plan: PLANS.pro, period }),
    hoursUsed: async () => used,
    sentAlerts: async () => new Set(sent),
    claimAlert: async (_o, _p, threshold) => {
      if (claimed.has(threshold)) return false;
      claimed.add(threshold);
      return true;
    },
    emailAdmins: async (_o, threshold) => void emailed.push(threshold),
    runningBoxes: async () => [
      { id: "c-1", sandboxId: "sb-1" },
      { id: "c-2", sandboxId: "sb-2" },
    ],
    pause: async (box) => void paused.push(box.sandboxId),
    log: () => {},
  };
  return { deps, emailed, paused };
}

test("each threshold crossed is emailed once; below the limit nothing is paused", async () => {
  const w = world(85, { limitPercent: null, alertThresholds: [50, 80, 100] });
  const report = await sweepOrgUsage(w.deps);
  assert.deepEqual(w.emailed, [50, 80]);
  assert.deepEqual(w.paused, []);
  assert.equal(report.alerts, 2);
  // Sent already: not again.
  const again = world(85, { limitPercent: null, alertThresholds: [50, 80, 100] }, new Set([50, 80]));
  await sweepOrgUsage(again.deps);
  assert.deepEqual(again.emailed, []);
});

test("at the admins' limit, the org's running boxes pause", async () => {
  const w = world(80, { limitPercent: 80, alertThresholds: [] });
  const report = await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, ["sb-1", "sb-2"]);
  assert.equal(report.paused, 2);
});

test("an org with no limit and no alerts isn't looked at", async () => {
  let asked = false;
  const w = world(500, { limitPercent: null, alertThresholds: [] });
  w.deps.hoursUsed = async () => {
    asked = true;
    return 500;
  };
  await sweepOrgUsage(w.deps);
  assert.equal(asked, false);
  assert.deepEqual(w.paused, []);
});

test("a box that won't pause doesn't stop the others", async () => {
  const w = world(90, { limitPercent: 50, alertThresholds: [] });
  w.deps.pause = async (box) => {
    if (box.sandboxId === "sb-1") throw new Error("gone");
    w.paused.push(box.sandboxId);
  };
  const report = await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, ["sb-2"]);
  assert.equal(report.failed, 1);
});

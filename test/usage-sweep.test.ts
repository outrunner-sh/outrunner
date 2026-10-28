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
    releaseAlert: async (_o, _p, threshold) => void claimed.delete(threshold),
    canEmail: true,
    emailAdmins: async (_o, threshold) => {
      emailed.push(threshold);
      return "sent";
    },
    canPause: true,
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

test("an alert whose email didn't go is taken back, to be tried again; none is claimed without email", async () => {
  const w = world(85, { limitPercent: null, alertThresholds: [80] });
  w.deps.emailAdmins = async () => "failed";
  let released = 0;
  w.deps.releaseAlert = async () => void (released += 1);
  const report = await sweepOrgUsage(w.deps);
  assert.equal(report.alerts, 0);
  assert.equal(released, 1);

  const off = world(85, { limitPercent: null, alertThresholds: [80] });
  off.deps.canEmail = false;
  let claims = 0;
  off.deps.claimAlert = async () => {
    claims += 1;
    return true;
  };
  await sweepOrgUsage(off.deps);
  assert.equal(claims, 0);
});

test("where boxes can't be paused, running ones run on at the limit", async () => {
  const w = world(90, { limitPercent: 50, alertThresholds: [] });
  w.deps.canPause = false;
  await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, []);
});

test("an email that throws gives its alert back, and the limit is still looked at", async () => {
  const w = world(90, { limitPercent: 50, alertThresholds: [80] });
  w.deps.emailAdmins = async () => {
    throw new Error("database blip");
  };
  let released = 0;
  w.deps.releaseAlert = async () => void (released += 1);
  await sweepOrgUsage(w.deps);
  assert.equal(released, 1);
  assert.deepEqual(w.paused, ["sb-1", "sb-2"]);
});

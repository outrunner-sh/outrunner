import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANS } from "@/lib/billing/plans";
import type { UsageControls } from "@/lib/billing/usage-controls";
import { type Account, orgLimitReason, pauseReason, planHoursReason, sweepOrgUsage, type UsageSweepDeps } from "@/lib/billing/usage-sweep";

const period = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

function world(used: number, controls: UsageControls, sent = new Set<number>(), accounts: Account[] = [{ kind: "team", orgId: "o-1" }]) {
  const emailed: number[] = [];
  const paused: string[] = [];
  const reasons: string[] = [];
  const claimed = new Set(sent);
  const deps: UsageSweepDeps = {
    busyAccounts: async () => accounts,
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
      { id: "c-1", sandboxId: "sb-1", ownerId: "u-1", workspaceId: "w-1" },
      { id: "c-2", sandboxId: "sb-2", ownerId: "u-2", workspaceId: "w-2" },
    ],
    exempt: async () => false,
    pause: async (box, reason) => {
      paused.push(box.sandboxId);
      reasons.push(reason);
    },
    log: () => {},
  };
  return { deps, emailed, paused, reasons };
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
  assert.equal(w.reasons[0], orgLimitReason(PLANS.pro, { limitPercent: 80, alertThresholds: [] }));
});

test("an org with no limit and no alerts still pauses at its plan's hours", async () => {
  const within = world(PLANS.pro.cloudHoursPerMonth - 1, { limitPercent: null, alertThresholds: [] });
  await sweepOrgUsage(within.deps);
  assert.deepEqual(within.paused, []);
  const over = world(PLANS.pro.cloudHoursPerMonth, { limitPercent: null, alertThresholds: [] });
  const report = await sweepOrgUsage(over.deps);
  assert.deepEqual(over.paused, ["sb-1", "sb-2"]);
  assert.equal(report.paused, 2);
  assert.deepEqual(over.emailed, []);
  assert.deepEqual(over.reasons, [planHoursReason(PLANS.pro), planHoursReason(PLANS.pro)]);
});

test("every owner over their plan's hours is paused: personal orgs and connectors too, with no admins' controls read", async () => {
  for (const account of [{ kind: "personal", orgId: "o-me" }, { kind: "connector", ownerId: "u-bot" }] as Account[]) {
    const w = world(PLANS.pro.cloudHoursPerMonth + 3, { limitPercent: 50, alertThresholds: [50] }, new Set(), [account]);
    let controlsRead = false;
    w.deps.controls = async () => {
      controlsRead = true;
      return { limitPercent: 50, alertThresholds: [50] };
    };
    const seen: Account[] = [];
    w.deps.hoursUsed = async (a) => {
      seen.push(a);
      return PLANS.pro.cloudHoursPerMonth + 3;
    };
    await sweepOrgUsage(w.deps);
    assert.deepEqual(seen, [account]);
    assert.equal(controlsRead, false);
    assert.deepEqual(w.emailed, []);
    assert.deepEqual(w.paused, ["sb-1", "sb-2"]);
    assert.match(w.reasons[0], /plan's 100 cloud hours are used up/);
  }
});

test("a personal org within its hours runs on", async () => {
  const w = world(10, { limitPercent: null, alertThresholds: [] }, new Set(), [{ kind: "personal", orgId: "o-me" }]);
  await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, []);
});

test("an owner exempt from plan limits keeps their box; the org's others pause", async () => {
  const w = world(PLANS.pro.cloudHoursPerMonth * 2, { limitPercent: null, alertThresholds: [] });
  w.deps.exempt = async (ownerId) => ownerId === "u-1";
  const report = await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, ["sb-2"]);
  assert.equal(report.paused, 1);
});

test("the plan's reason offers an upgrade only where there is one to buy", () => {
  assert.match(planHoursReason(PLANS.free), /upgrade for more hours/);
  assert.match(planHoursReason(PLANS.pro, "team"), /upgrade for more hours/);
  for (const [plan, kind] of [[PLANS.max, "team"], [PLANS.enterprise, "personal"], [PLANS.pro, "connector"]] as const) {
    const reason = planHoursReason(plan, kind);
    assert.doesNotMatch(reason, /upgrade/);
    assert.match(reason, /start again next period/);
  }
});

test("the reason is the limit that stops it: the admins' below the plan's, the plan's past both", () => {
  const controls = { limitPercent: 50, alertThresholds: [] };
  assert.equal(pauseReason(PLANS.pro, controls, 40), null);
  assert.equal(pauseReason(PLANS.pro, controls, 50), orgLimitReason(PLANS.pro, controls));
  assert.equal(pauseReason(PLANS.pro, controls, 100), planHoursReason(PLANS.pro));
  assert.equal(pauseReason(PLANS.pro, null, 99.9), null);
  assert.match(orgLimitReason(PLANS.pro, controls), /^Its box was paused: the org's usage limit \(50% of its plan's 100/);
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

test("Max boxes keep running beyond 500 hours, including with saved org limits", async () => {
  for (const account of [
    { kind: "team", orgId: "o-1" },
    { kind: "personal", orgId: "o-me" },
  ] as Account[]) {
    const w = world(100000, { limitPercent: 50, alertThresholds: [50, 80, 100] }, new Set(), [account]);
    w.deps.entitlements = async () => ({ plan: PLANS.max, period });
    const report = await sweepOrgUsage(w.deps);
    assert.deepEqual(w.paused, []);
    assert.deepEqual(w.emailed, []);
    assert.equal(report.failed, 0);
  }
});

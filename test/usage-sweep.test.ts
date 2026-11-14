import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorPlan, type Plan, PLANS } from "@/lib/billing/plans";
import type { AccountStanding } from "@/lib/billing/standing";
import { TRIAL_PERIOD, usageCost, usageStanding } from "@/lib/billing/usage";
import { limitFor, type UsageControls } from "@/lib/billing/usage-controls";
import { type Account, pauseReason, sweepOrgUsage, type UsageSweepDeps } from "@/lib/billing/usage-sweep";

const period = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };
const none: UsageControls = { limitUsd: null, alertThresholds: [] };

/** An account on `plan` that has run `vcpuHours` this period. */
function standingOf(plan: Plan, vcpuHours: number, controls: UsageControls = none, unpaidSince: Date | null = null): AccountStanding {
  return {
    plan,
    period: plan.usage.per === "once" ? TRIAL_PERIOD : period,
    controls,
    standing: usageStanding({ plan, cost: usageCost(plan, vcpuHours), limitUsd: limitFor(plan, controls), unpaidSince }),
  };
}

function world(account: AccountStanding, sent = new Set<number>(), accounts: Account[] = [{ kind: "team", orgId: "o-1" }]) {
  const emailed: number[] = [];
  const paused: string[] = [];
  const reasons: string[] = [];
  const claimed = new Set(sent);
  const periods: Date[] = [];
  const deps: UsageSweepDeps = {
    busyAccounts: async () => accounts,
    standing: async () => account,
    sentAlerts: async (_o, p) => {
      periods.push(p.start);
      return new Set(sent);
    },
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
  return { deps, emailed, paused, reasons, periods };
}

test("each state does what it says to running boxes: pause where usage stops the account, else run on", async () => {
  const unpaid = new Date("2026-11-10T00:00:00Z");
  const cases: Array<[string, AccountStanding, string[], RegExp | null]> = [
    ["within", standingOf(PLANS.pro, 100), [], null],
    ["overage is billed, not paused", standingOf(PLANS.pro, 1000), [], null],
    ["unpaid refuses starts but pauses nothing", standingOf(PLANS.pro, 10, none, unpaid), [], null],
    ["at the admins' limit", standingOf(PLANS.pro, 400, { limitUsd: 30, alertThresholds: [] }), ["sb-1", "sb-2"], /usage limit of \$30\.00 is reached.*an admin can raise the limit/],
    ["the trial's credit spent", standingOf(PLANS.free, 1000), ["sb-1", "sb-2"], /the free trial's \$100\.00 of cloud usage is used up\. Its files are kept; subscribe to keep going\.$/],
    ["a contract's usage spent", standingOf(PLANS.enterprise, 1000), ["sb-1", "sb-2"], /Enterprise plan's \$120\.00 .* it can start again next period\.$/],
  ];
  for (const [what, account, paused, reason] of cases) {
    const w = world(account);
    const report = await sweepOrgUsage(w.deps);
    assert.deepEqual(w.paused, paused, what);
    assert.equal(report.paused, paused.length, what);
    if (reason) {
      assert.match(w.reasons[0], /^Its box was paused: /, what);
      assert.match(w.reasons[0], reason, what);
      assert.equal(pauseReason(account), w.reasons[0], what);
    } else assert.equal(pauseReason(account), null, what);
  }
});

test("each threshold crossed is emailed once, for personal orgs too, and never for a connector", async () => {
  // $18 of Pro's $20: 90%.
  const ninety = (controls: UsageControls) => standingOf(PLANS.pro, 150, controls);
  const alerts: UsageControls = { limitUsd: null, alertThresholds: [50, 80, 100] };
  for (const account of [{ kind: "team", orgId: "o-1" }, { kind: "personal", orgId: "o-me" }] as Account[]) {
    const w = world(ninety(alerts), new Set(), [account]);
    const report = await sweepOrgUsage(w.deps);
    assert.deepEqual(w.emailed, [50, 80], account.kind);
    assert.equal(report.alerts, 2);
    assert.deepEqual(w.paused, []);
  }
  const again = world(ninety(alerts), new Set([50, 80]));
  await sweepOrgUsage(again.deps);
  assert.deepEqual(again.emailed, []);

  const connector = world(standingOf(connectorPlan(50), 1000, alerts), new Set(), [{ kind: "connector", ownerId: "u-bot" }]);
  await sweepOrgUsage(connector.deps);
  assert.deepEqual(connector.emailed, []);
  assert.deepEqual(connector.paused, ["sb-1", "sb-2"]);
});

test("the trial's alerts are once ever: keyed to the trial's period", async () => {
  const w = world(standingOf(PLANS.free, 700, { limitUsd: null, alertThresholds: [80] }));
  await sweepOrgUsage(w.deps);
  assert.deepEqual(w.emailed, [80]);
  assert.deepEqual(w.periods, [TRIAL_PERIOD.start]);
});

test("an owner exempt from plan limits keeps their box; the org's others pause", async () => {
  const w = world(standingOf(PLANS.free, 1000));
  w.deps.exempt = async (ownerId) => ownerId === "u-1";
  const report = await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, ["sb-2"]);
  assert.equal(report.paused, 1);
});

test("a box that won't pause doesn't stop the others", async () => {
  const w = world(standingOf(PLANS.free, 1000));
  w.deps.pause = async (box) => {
    if (box.sandboxId === "sb-1") throw new Error("gone");
    w.paused.push(box.sandboxId);
  };
  const report = await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, ["sb-2"]);
  assert.equal(report.failed, 1);
});

test("an account whose standing can't be read fails alone", async () => {
  const w = world(standingOf(PLANS.free, 1000), new Set(), [{ kind: "team", orgId: "o-1" }, { kind: "team", orgId: "o-2" }]);
  let calls = 0;
  const account = standingOf(PLANS.free, 1000);
  w.deps.standing = async () => {
    calls += 1;
    if (calls === 1) throw new Error("controls unreadable");
    return account;
  };
  const report = await sweepOrgUsage(w.deps);
  assert.equal(report.failed, 1);
  assert.deepEqual(w.paused, ["sb-1", "sb-2"]);
  assert.deepEqual(w.emailed, []);
});

test("an alert whose email didn't go is taken back, to be tried again; none is claimed without email", async () => {
  const eighty: UsageControls = { limitUsd: null, alertThresholds: [80] };
  const w = world(standingOf(PLANS.pro, 150, eighty));
  w.deps.emailAdmins = async () => "failed";
  let released = 0;
  w.deps.releaseAlert = async () => void (released += 1);
  const report = await sweepOrgUsage(w.deps);
  assert.equal(report.alerts, 0);
  assert.equal(released, 1);

  const off = world(standingOf(PLANS.pro, 150, eighty));
  off.deps.canEmail = false;
  let claims = 0;
  off.deps.claimAlert = async () => {
    claims += 1;
    return true;
  };
  await sweepOrgUsage(off.deps);
  assert.equal(claims, 0);
});

test("an email that throws gives its alert back, and the pause is still looked at", async () => {
  const w = world(standingOf(PLANS.free, 1000, { limitUsd: null, alertThresholds: [80] }));
  w.deps.emailAdmins = async () => {
    throw new Error("database blip");
  };
  let released = 0;
  w.deps.releaseAlert = async () => void (released += 1);
  await sweepOrgUsage(w.deps);
  assert.equal(released, 1);
  assert.deepEqual(w.paused, ["sb-1", "sb-2"]);
});

test("where boxes can't be paused, running ones run on", async () => {
  const w = world(standingOf(PLANS.free, 1000));
  w.deps.canPause = false;
  await sweepOrgUsage(w.deps);
  assert.deepEqual(w.paused, []);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarMonth, type Interval, OPEN_GRACE_MS } from "@/lib/billing/hours";
import { connectorPlan, PLANS, type Plan } from "@/lib/billing/plans";
import { BOX_SIZES } from "@/lib/runtime/box-sizes";
import { LONGEST_INTERVAL_MS, MAX_BOX_RUN_HARD_MS } from "@/lib/billing/reconcile";
import {
  TRIAL_PERIOD,
  blocksStarts,
  formatUsd,
  pausesRunning,
  usageCost,
  type UsageCost,
  usagePeriod,
  usageStanding,
  type UsageState,
  vcpuHoursUsed,
} from "@/lib/billing/usage";

const at = (iso: string) => new Date(iso);
const october = calendarMonth(at("2026-10-17T12:00:00Z"));
const now = at("2026-10-17T12:00:00Z");

function run(sandboxId: string, start: string, end: string | null, opts: { cpu?: number; seen?: string } = {}): Interval {
  return {
    sandboxId,
    cpu: opts.cpu ?? 2,
    startedAt: at(start),
    lastSeenAt: at(opts.seen ?? end ?? start),
    endedAt: end ? at(end) : null,
  };
}

/** What `intervals` cost on `plan` in October, at `when`. */
function cost(plan: Plan, intervals: Interval[], when = now): UsageCost {
  return usageCost(plan, vcpuHoursUsed(intervals, october, when));
}

test("paid plans include their price; the trial is a one-off $10; overage only where there's a price", () => {
  for (const plan of [PLANS.pro, PLANS.max]) {
    assert.equal(plan.usage.includedUsd, plan.priceUsd);
    assert.deepEqual([plan.usage.per, plan.usage.overage], ["month", true]);
  }
  assert.deepEqual(PLANS.free.usage, { includedUsd: 10, per: "once", overage: false });
  assert.equal(PLANS.enterprise.usage.overage, false);
  assert.equal(connectorPlan(50).usage.overage, false);
});

test("an hour costs 12¢ a vCPU at the included rate, for every box size", () => {
  const cents = BOX_SIZES.map((size) => cost(PLANS.max, [run(size.id, "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z", { cpu: size.cpu })]).totalCents);
  assert.deepEqual(cents, [12, 24, 48, 96]);
});

test("an ended session costs at least a minute; one still running costs what it has run", () => {
  const cases: Array<[string, Interval[], Date, number]> = [
    // [what, intervals, now, vCPU-minutes billed]
    ["20 seconds, ended", [run("a", "2026-10-02T10:00:00Z", "2026-10-02T10:00:20Z")], now, 2],
    ["20 seconds, running", [run("a", "2026-10-17T11:59:40Z", null, { seen: "2026-10-17T11:59:55Z" })], now, 2 / 3],
    ["two short wakes of one box are two sessions", [
      run("a", "2026-10-02T10:00:00Z", "2026-10-02T10:00:10Z"),
      run("a", "2026-10-02T11:00:00Z", "2026-10-02T11:00:10Z"),
    ], now, 4],
    ["overlapping intervals are one session, so one minimum", [
      run("a", "2026-10-02T10:00:00Z", "2026-10-02T10:00:20Z"),
      run("a", "2026-10-02T10:00:10Z", "2026-10-02T10:00:30Z"),
    ], now, 2],
    ["over a minute is billed as it ran", [run("a", "2026-10-02T10:00:00Z", "2026-10-02T10:01:30Z")], now, 3],
    ["just ended: the minimum is owed already", [run("a", "2026-10-17T11:59:40Z", "2026-10-17T11:59:50Z")], now, 2],
    ["the minimum stops at the period's end", [run("a", "2026-10-31T23:59:30Z", "2026-10-31T23:59:40Z")], at("2026-11-01T00:05:00Z"), 1],
  ];
  for (const [what, intervals, when, vcpuMinutes] of cases) {
    assert.ok(Math.abs(vcpuHoursUsed(intervals, october, when) * 60 - vcpuMinutes) < 1e-9, what);
  }
});

test("only the period's part counts, and nothing from the future", () => {
  const cases: Array<[string, Interval[], number]> = [
    ["across the month's start: 2 of 3 hours", [run("a", "2026-09-30T23:00:00Z", "2026-10-01T02:00:00Z")], 4],
    ["all in September", [run("a", "2026-09-10T00:00:00Z", "2026-09-10T05:00:00Z")], 0],
    ["recorded as ending after now", [run("a", "2026-10-17T11:00:00Z", "2026-10-17T14:00:00Z")], 2],
    ["starting after now", [run("a", "2026-10-17T13:00:00Z", "2026-10-17T13:00:10Z")], 0],
    ["backwards", [run("a", "2026-10-17T11:00:00Z", "2026-10-17T10:00:00Z")], 0],
    ["a box unseen counts to its last sighting plus the grace", [run("a", "2026-10-17T09:00:00Z", null, { seen: "2026-10-17T10:00:00Z" })], 2 * (1 + OPEN_GRACE_MS / 3_600_000)],
    ["nothing", [], 0],
  ];
  for (const [what, intervals, vcpuHours] of cases) {
    assert.ok(Math.abs(vcpuHoursUsed(intervals, october, now) - vcpuHours) < 1e-9, what);
  }
});

test("past the included usage, overage is 1.5x on Pro and Max", () => {
  // 100 Small hours = 200 vCPU-hours = $24 at the included rate. Pro's $20
  // covers 166⅔ of them; the other 33⅓ are overage at 18¢: $6.
  const hundredHours = [run("a", "2026-10-02T00:00:00Z", "2026-10-06T04:00:00Z")];
  assert.deepEqual(cost(PLANS.pro, hundredHours), { includedCents: 2000, overageCents: 600, totalCents: 2600, includedSpent: true });
  assert.deepEqual(cost(PLANS.max, hundredHours), { includedCents: 2400, overageCents: 0, totalCents: 2400, includedSpent: false });
});

test("a plan without overage stops at what it includes", () => {
  // Enterprise includes $120: exactly 500 Small hours.
  const monthEnd = october.end;
  const hours = (n: number) => [run("a", "2026-10-01T00:00:00Z", new Date(october.start.getTime() + n * 3_600_000).toISOString())];
  assert.deepEqual(cost(PLANS.enterprise, hours(499), monthEnd), { includedCents: 11976, overageCents: 0, totalCents: 11976, includedSpent: false });
  assert.deepEqual(cost(PLANS.enterprise, hours(500), monthEnd), { includedCents: 12000, overageCents: 0, totalCents: 12000, includedSpent: true });
  assert.deepEqual(cost(PLANS.enterprise, hours(600), monthEnd), { includedCents: 12000, overageCents: 0, totalCents: 12000, includedSpent: true });
  // The trial's $10 is 41⅔ Small hours.
  assert.equal(cost(PLANS.free, hours(42), monthEnd).includedSpent, true);
  assert.equal(cost(PLANS.free, hours(41), monthEnd).includedSpent, false);
  // Within half a cent of the cap it shows as all used, so it is: 999.6¢ reads $10.00 of $10.00.
  assert.deepEqual(usageCost(PLANS.free, 83.3), { includedCents: 1000, overageCents: 0, totalCents: 1000, includedSpent: true });
});

test("cents round once, over the whole period, not per session", () => {
  // Three one-minute Small sessions: 0.4¢ each. Rounded each, 0¢; together, 1.2¢ → 1¢.
  const three = ["a", "b", "c"].map((box) => run(box, "2026-10-02T10:00:00Z", "2026-10-02T10:01:00Z"));
  assert.equal(cost(PLANS.max, three).totalCents, 1);
  assert.equal(cost(PLANS.max, three.slice(0, 1)).totalCents, 0);
});

test("the cost never falls as time passes, never goes negative, and doesn't care which box ran first", () => {
  const scenarios: Interval[][] = [
    [run("a", "2026-10-02T00:00:00Z", "2026-10-06T04:00:00Z")],
    [run("a", "2026-10-17T11:59:40Z", "2026-10-17T11:59:50Z"), run("b", "2026-10-17T11:00:00Z", null, { seen: "2026-10-17T11:58:00Z" })],
    [run("a", "2026-10-03T00:00:00Z", "2026-10-05T00:00:00Z", { cpu: 8 }), run("b", "2026-10-04T00:00:00Z", "2026-10-09T00:00:00Z", { cpu: 1 })],
  ];
  const times = ["2026-10-02T12:00:00Z", "2026-10-06T00:00:00Z", "2026-10-17T11:59:45Z", "2026-10-17T12:00:00Z", "2026-10-17T12:30:00Z", "2026-11-02T00:00:00Z"].map(at);
  for (const plan of [PLANS.free, PLANS.pro, PLANS.max, PLANS.enterprise]) {
    for (const intervals of scenarios) {
      let last = 0;
      for (const when of times) {
        const c = cost(plan, intervals, when);
        assert.ok(c.totalCents >= last && c.overageCents >= 0 && c.includedCents >= 0, `${plan.id} at ${when.toISOString()}`);
        assert.deepEqual(cost(plan, [...intervals].reverse(), when), c);
        last = c.totalCents;
      }
    }
  }
});

test("standing: the worst state wins, and each says whether boxes start or pause", () => {
  const spentTrial = usageCost(PLANS.free, 1_000);
  const proOver = usageCost(PLANS.pro, 200); // $26: $6 over
  const proWithin = usageCost(PLANS.pro, 100); // $12
  const unpaid = at("2026-10-15T00:00:00Z");
  const cases: Array<[string, Parameters<typeof usageStanding>[0], UsageState]> = [
    ["the trial's credit is spent", { plan: PLANS.free, cost: spentTrial, limitUsd: null, unpaidSince: null }, "included_spent"],
    ["spent beats the admins' limit", { plan: PLANS.free, cost: spentTrial, limitUsd: 5, unpaidSince: unpaid }, "included_spent"],
    ["at the admins' limit", { plan: PLANS.pro, cost: proOver, limitUsd: 26, unpaidSince: null }, "at_limit"],
    ["the limit beats unpaid", { plan: PLANS.pro, cost: proOver, limitUsd: 25, unpaidSince: unpaid }, "at_limit"],
    ["under the limit, unpaid", { plan: PLANS.pro, cost: proOver, limitUsd: 30, unpaidSince: unpaid }, "unpaid"],
    ["unpaid even within the included usage", { plan: PLANS.pro, cost: proWithin, limitUsd: null, unpaidSince: unpaid }, "unpaid"],
    ["in overage", { plan: PLANS.pro, cost: proOver, limitUsd: null, unpaidSince: null }, "overage"],
    ["within", { plan: PLANS.pro, cost: proWithin, limitUsd: null, unpaidSince: null }, "within"],
  ];
  for (const [what, input, state] of cases) assert.equal(usageStanding(input).state, state, what);

  const standing = usageStanding({ plan: PLANS.pro, cost: proOver, limitUsd: 30, unpaidSince: null });
  assert.deepEqual([standing.includedCapCents, standing.limitCents, standing.totalCents], [2000, 3000, 2600]);

  const rules = (["included_spent", "at_limit", "unpaid", "overage", "within"] as const).map((s) => [s, blocksStarts(s), pausesRunning(s)]);
  assert.deepEqual(rules, [
    ["included_spent", true, true],
    ["at_limit", true, true],
    ["unpaid", true, false],
    ["overage", false, false],
    ["within", false, false],
  ]);
});

test("the period: the calendar month by default, from launch on for the trial, a monthly Free with billing off", () => {
  assert.deepEqual(october, { start: at("2026-10-01T00:00:00Z"), end: at("2026-11-01T00:00:00Z") });
  assert.deepEqual(calendarMonth(at("2026-12-31T23:59:59Z")).end, at("2027-01-01T00:00:00Z"));
  const subscribed = { start: at("2026-10-12T00:00:00Z"), end: at("2026-11-12T00:00:00Z") };
  assert.deepEqual(usagePeriod(PLANS.free, null, now, "stripe"), TRIAL_PERIOD);
  // Nothing to subscribe to: a trial that never renewed would stop the deployment for good.
  assert.deepEqual(usagePeriod(PLANS.free, null, now, "off"), october);
  assert.deepEqual(usagePeriod(PLANS.pro, subscribed, now, "stripe"), subscribed);
  assert.deepEqual(usagePeriod(PLANS.enterprise, null, now, "stripe"), october);
  assert.ok(TRIAL_PERIOD.end.toISOString().startsWith("9999-"));
});

test("usage reads look back past the longest an ended interval can run", () => {
  assert.ok(LONGEST_INTERVAL_MS > MAX_BOX_RUN_HARD_MS + OPEN_GRACE_MS);
});

test("cents read as dollars", () => {
  assert.deepEqual([0, 5, 1000, 123456].map(formatUsd), ["$0.00", "$0.05", "$10.00", "$1234.56"]);
});

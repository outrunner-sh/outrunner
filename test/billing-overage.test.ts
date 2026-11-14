import assert from "node:assert/strict";
import { test } from "node:test";

import type { Period } from "@/lib/billing/hours";
import {
  CHARGE_AT_CENTS,
  chargeOverage,
  openItemTarget,
  type OverageAccount,
  overageAccountsFrom,
  type OverageDeps,
  type OverageItem,
  REPORT_TAIL_MS,
  reportOverage,
  unpaidSinceOf,
} from "@/lib/billing/overage";
import { periodBefore } from "@/lib/billing/periods";
import { PLANS } from "@/lib/billing/plans";
import type { SubscriptionRecord } from "@/lib/billing/subscriptions";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-20T12:00:00Z");
const NOVEMBER: Period = { start: at("2026-11-12T00:00:00Z"), end: at("2026-12-12T00:00:00Z") };
const OCTOBER: Period = { start: at("2026-10-12T00:00:00Z"), end: at("2026-11-12T00:00:00Z") };
const item = (id: string, amountCents: number, state: OverageItem["state"], period = NOVEMBER): OverageItem => ({
  id,
  periodStart: period.start.toISOString(),
  amountCents,
  state,
});

test("a period's open item holds its overage less what's already invoiced", () => {
  const cases: Array<[string, number, OverageItem[], string | null, number]> = [
    ["nothing yet", 1200, [], null, 1200],
    ["one pending item", 1800, [item("ii_1", 1200, "pending")], "ii_1", 1800],
    ["on the renewal's draft: still changeable", 1800, [item("ii_1", 1200, "draft")], "ii_1", 1800],
    ["after a charge, the next item holds the rest", 7000, [item("ii_1", 5200, "invoiced")], null, 1800],
    ["after a charge, with the next pending", 7000, [item("ii_1", 5200, "invoiced"), item("ii_2", 900, "pending")], "ii_2", 1800],
    ["overage that shrank under what's invoiced owes nothing more", 5100, [item("ii_1", 5200, "invoiced")], null, 0],
  ];
  for (const [what, overage, items, open, target] of cases) {
    const result = openItemTarget(overage, items);
    assert.equal(result.open?.id ?? null, open, what);
    assert.equal(result.targetCents, target, what);
  }
});

/** Stripe holding `items`, an account owing `owed` cents a period. */
function world(owed: Record<string, number>, items: OverageItem[] = [], accounts?: OverageAccount[]) {
  const calls: string[] = [];
  const keys: string[] = [];
  const account: OverageAccount = { orgId: "o-1", customerId: "cus_1", plan: PLANS.pro, period: NOVEMBER, tail: null, ended: false };
  const deps: OverageDeps = {
    accounts: async () => accounts ?? [account],
    overageCents: async (_a, period) => owed[period.start.toISOString()] ?? 0,
    items: async () => items,
    setItemAmount: async (id, cents, key) => {
      calls.push(`set ${id} ${cents}`);
      keys.push(key);
    },
    createItem: async ({ period, amountCents, idempotencyKey }) => {
      calls.push(`create ${period.start.toISOString().slice(0, 10)} ${amountCents}`);
      keys.push(idempotencyKey);
    },
    chargePending: async ({ orgId, idempotencyKey }) => {
      calls.push(`charge ${orgId}`);
      keys.push(idempotencyKey);
    },
    log: () => {},
  };
  return { deps, calls, keys, account };
}

const nov = NOVEMBER.start.toISOString();
const oct = OCTOBER.start.toISOString();

test("reporting creates the period's item, then sets it to what's owed, and leaves it when it already is", async () => {
  const fresh = world({ [nov]: 1200 });
  assert.deepEqual((await reportOverage(fresh.deps, NOW)).created, 1);
  assert.deepEqual(fresh.calls, ["create 2026-11-12 1200"]);
  assert.deepEqual(fresh.keys, [`overage-create:o-1:${nov}:0:1200`]);

  const grown = world({ [nov]: 1800 }, [item("ii_1", 1200, "pending")]);
  await reportOverage(grown.deps, NOW);
  assert.deepEqual(grown.calls, ["set ii_1 1800"]);
  assert.deepEqual(grown.keys, ["overage-set:ii_1:1800"]);

  const same = world({ [nov]: 1800 }, [item("ii_1", 1800, "pending")]);
  await reportOverage(same.deps, NOW);
  assert.deepEqual(same.calls, []);

  const none = world({ [nov]: 0 });
  await reportOverage(none.deps, NOW);
  assert.deepEqual(none.calls, []);
});

test("a run repeated with the same usage makes the same calls, with the same keys", async () => {
  const first = world({ [nov]: 1800 }, [item("ii_1", 1200, "pending")]);
  const again = world({ [nov]: 1800 }, [item("ii_1", 1200, "pending")]);
  await reportOverage(first.deps, NOW);
  await reportOverage(again.deps, NOW);
  assert.deepEqual(first.keys, again.keys);
});

test("the period just ended keeps its item up to date, but never gets a new one", async () => {
  const w = world({ [oct]: 900, [nov]: 300 }, [item("ii_old", 700, "draft", OCTOBER)]);
  w.account.tail = OCTOBER;
  await reportOverage(w.deps, NOW);
  assert.deepEqual(w.calls, ["set ii_old 900", "create 2026-11-12 300"]);

  // A subscription in its first days: the month before it began has no item
  // of its own, and an earlier plan covered its usage, so nothing is billed.
  const fresh = world({ [oct]: 50_000, [nov]: 300 });
  fresh.account.tail = OCTOBER;
  await reportOverage(fresh.deps, NOW);
  assert.deepEqual(fresh.calls, ["create 2026-11-12 300"]);
});

test("one account failing doesn't stop the others", async () => {
  const bad: OverageAccount = { orgId: "o-bad", customerId: "cus_bad", plan: PLANS.pro, period: NOVEMBER, tail: null, ended: false };
  const good: OverageAccount = { orgId: "o-good", customerId: "cus_good", plan: PLANS.pro, period: NOVEMBER, tail: null, ended: false };
  const w = world({ [nov]: 500 }, [], [bad, good]);
  const items = w.deps.items;
  w.deps.items = async (customer, since) => {
    if (customer === "cus_bad") throw new Error("Stripe down");
    return items(customer, since);
  };
  const report = await reportOverage(w.deps, NOW);
  assert.equal(report.failed, 1);
  assert.equal(report.created, 1);
});

test("pending overage is charged at $50 or more, or any amount once the subscription has ended", async () => {
  const cases: Array<[string, OverageItem[], boolean, boolean]> = [
    ["under $50 waits for renewal", [item("ii_1", CHARGE_AT_CENTS - 1, "pending")], false, false],
    ["$50 is charged now", [item("ii_1", CHARGE_AT_CENTS, "pending")], false, true],
    ["pending items add up", [item("ii_1", 3000, "pending"), item("ii_2", 2000, "pending", OCTOBER)], false, true],
    ["the renewal's draft and invoiced items aren't pending", [item("ii_1", 9000, "draft"), item("ii_2", 9000, "invoiced")], false, false],
    ["ended: what's left is charged", [item("ii_1", 300, "pending")], true, true],
    ["ended with nothing pending: nothing", [], true, false],
  ];
  for (const [what, items, ended, charged] of cases) {
    const w = world({}, items);
    w.account.ended = ended;
    await chargeOverage(w.deps, NOW);
    assert.deepEqual(w.calls, charged ? ["charge o-1"] : [], what);
  }
  const w = world({}, [item("ii_b", 3000, "pending"), item("ii_a", 2000, "pending")]);
  await chargeOverage(w.deps, NOW);
  assert.deepEqual(w.keys, ["overage-charge:ii_a,ii_b:5000"]);

  // Every pending item counts, read from the start of time: a yearly
  // subscription's earlier months add up past $50 with this month's $20.
  const sinces: Date[] = [];
  const AUGUST: Period = { start: at("2026-08-12T00:00:00Z"), end: at("2026-09-12T00:00:00Z") };
  const SEPTEMBER: Period = { start: at("2026-09-12T00:00:00Z"), end: at("2026-10-12T00:00:00Z") };
  const months = [item("ii_aug", 3000, "pending", AUGUST), item("ii_sep", 3000, "pending", SEPTEMBER), item("ii_oct", 2000, "pending", OCTOBER)];
  const yearly = world({}, months);
  yearly.deps.items = async (_c, since) => {
    sinces.push(since);
    return since.getTime() === 0 ? months : months.slice(2);
  };
  await chargeOverage(yearly.deps, NOW);
  assert.deepEqual(yearly.calls, ["charge o-1"]);
  assert.deepEqual(sinces, [new Date(0)]);
});

function subscription(over: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    stripeSubscriptionId: "sub_1",
    orgId: "o-1",
    userId: "u-1",
    stripeCustomerId: "cus_1",
    status: "active",
    plan: "pro",
    priceLookupKey: "pro_monthly",
    billingInterval: "month",
    currentPeriodStart: NOVEMBER.start,
    currentPeriodEnd: NOVEMBER.end,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    ...over,
  };
}

test("accounts: the current period on a plan with overage, and the one before just after a renewal", () => {
  assert.deepEqual(overageAccountsFrom([subscription()], NOW), [
    { orgId: "o-1", customerId: "cus_1", plan: PLANS.pro, period: NOVEMBER, tail: null, ended: false },
  ]);
  const justRenewed = new Date(NOVEMBER.start.getTime() + REPORT_TAIL_MS - 1);
  const renewed = overageAccountsFrom([subscription()], justRenewed)[0];
  assert.deepEqual([renewed.tail, renewed.period], [OCTOBER, NOVEMBER]);
  assert.deepEqual(overageAccountsFrom([subscription({ plan: "enterprise" })], NOW), []);
});

test("accounts: a subscription that ended is charged what's left of its last period, then forgotten", () => {
  const canceled = subscription({ status: "canceled", currentPeriodStart: OCTOBER.start, currentPeriodEnd: OCTOBER.end });
  const soon = new Date(OCTOBER.end.getTime() + 60 * 60_000);
  assert.deepEqual(overageAccountsFrom([canceled], soon), [
    { orgId: "o-1", customerId: "cus_1", plan: PLANS.pro, period: OCTOBER, tail: null, ended: true },
  ]);
  assert.deepEqual(overageAccountsFrom([canceled], new Date(OCTOBER.end.getTime() + REPORT_TAIL_MS)), []);
  // Past due beyond the grace: no plan now, but Stripe may still bill it, so
  // what's pending waits for $50 like any other.
  const lapsed = subscription({ status: "past_due", pastDueSince: at("2026-11-01T00:00:00Z"), currentPeriodStart: OCTOBER.start, currentPeriodEnd: OCTOBER.end });
  assert.equal(overageAccountsFrom([lapsed], soon)[0]?.ended, false);
});

test("the period before a renewal is the month ending where it starts", () => {
  assert.deepEqual(periodBefore(NOVEMBER), OCTOBER);
  // Anchored on the 31st: the period before March 31 starts on February's last day.
  assert.deepEqual(periodBefore({ start: at("2027-03-31T00:00:00Z"), end: at("2027-04-30T00:00:00Z") }).start, at("2027-02-28T00:00:00Z"));
});

test("unpaid since the earliest open overage invoice whose payment was tried", () => {
  assert.equal(unpaidSinceOf([]), null);
  assert.equal(unpaidSinceOf([{ created: at("2026-11-10T00:00:00Z"), attempted: false }]), null);
  assert.deepEqual(
    unpaidSinceOf([
      { created: at("2026-11-15T00:00:00Z"), attempted: true },
      { created: at("2026-11-10T00:00:00Z"), attempted: true },
      { created: at("2026-11-05T00:00:00Z"), attempted: false },
    ]),
    at("2026-11-10T00:00:00Z"),
  );
});

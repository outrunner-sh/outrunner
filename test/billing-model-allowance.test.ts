import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AllowanceState,
  type AllowanceStore,
  type AllowanceDeps,
  allowanceWithin,
  nextAllowance,
  ONCE,
  refreshAllowance,
  refuseUnusable,
} from "@/lib/billing/model-allowance";
import { AllowanceSpentError, ModelKeyDisabledError } from "@/lib/openrouter/keys";
import { PLANS } from "@/lib/billing/plans";

const october = { start: new Date("2026-10-17T00:00:00Z"), end: new Date("2026-11-17T00:00:00Z") };
const november = { start: new Date("2026-11-17T00:00:00Z"), end: new Date("2026-12-17T00:00:00Z") };
const free = { plan: PLANS.free, allowancePeriod: null };
const pro = (period = october) => ({ plan: PLANS.pro, allowancePeriod: period });
const max = (period = october) => ({ plan: PLANS.max, allowancePeriod: period });
/** No plan's models are unlimited now (Max is capped at $50), but the
 *  allowance still supports one, as Max was before usage-based billing. */
const unlimited = (period = october) => ({ plan: { ...PLANS.max, models: { usd: null, per: "month" as const } }, allowancePeriod: period });

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

test("an upgrade to an unlimited plan removes the cap, keeping what this period has used", () => {
  const onPro = nextAllowance(pro(), null, 0)!;
  const onMax = nextAllowance(unlimited(), onPro, 7);
  assert.deepEqual(onMax, { period: october.start.toISOString(), plan: "max", baselineUsd: 0, limitUsd: null });
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

/** One user's row and key: a CAS claim, as the database does it. */
function keyWorld(opts: { state?: AllowanceState | null; spent: number; cap: number | null; hash?: string | null }) {
  const row = { hash: opts.hash === undefined ? "h1" : opts.hash, state: opts.state ?? null };
  const key = { spent: opts.spent, cap: opts.cap, disabled: false };
  const patches: (number | null)[] = [];
  const store: AllowanceStore = {
    read: async () => ({ hash: row.hash, state: row.state }),
    claim: async (previous, next) => {
      if (JSON.stringify(row.state) !== JSON.stringify(previous)) return false;
      row.state = next;
      return true;
    },
  };
  const deps: AllowanceDeps = {
    usage: async () => ({ usedUsd: key.spent, limitUsd: key.cap, disabled: key.disabled }),
    setLimit: async (_hash: string, usd: number | null) => {
      patches.push(usd);
      key.cap = usd;
    },
    entitlements: async () => pro(),
  };
  return { row, key, patches, store, deps };
}

test("a new period is claimed, then the key's cap moved to it", async () => {
  const w = keyWorld({ state: nextAllowance(free, null, 2), spent: 2, cap: 5 });
  assert.deepEqual(await refreshAllowance(w.store, w.deps), { usedUsd: 0, limitUsd: 10, disabled: false });
  assert.deepEqual(w.patches, [12]);
  assert.equal(w.row.state?.period, october.start.toISOString());
  // Nothing changed: nothing is sent to OpenRouter.
  await refreshAllowance(w.store, w.deps);
  assert.deepEqual(w.patches, [12]);
});

test("two calls at once settle on one baseline: the period can't be granted twice", async () => {
  const w = keyWorld({ state: nextAllowance(free, null, 2), spent: 2, cap: 5 });
  // Another call claimed the period first, from its own reading of $2 spent...
  const winner = nextAllowance(pro(), w.row.state, 2)!;
  const store: AllowanceStore = {
    ...w.store,
    claim: async () => {
      w.row.state = winner;
      return false;
    },
  };
  // ...and the user has spent $4 more since: this call doesn't grant again from $6.
  w.key.spent = 6;
  assert.deepEqual(await refreshAllowance(store, w.deps), { usedUsd: 4, limitUsd: 10, disabled: false });
  assert.deepEqual(w.patches, [12], "the cap the winner claimed: $2 + $10");
});

test("a cap that failed to move after its claim is moved on the next call", async () => {
  const w = keyWorld({ state: nextAllowance(free, null, 2), spent: 2, cap: 5 });
  const failing = { ...w.deps, setLimit: async () => { throw new Error("OpenRouter down"); } };
  await assert.rejects(refreshAllowance(w.store, failing), /OpenRouter down/);
  assert.equal(w.key.cap, 5, "claimed, but the key still has the old cap");
  w.key.spent = 3;
  await refreshAllowance(w.store, w.deps);
  assert.deepEqual(w.patches, [12], "the claimed cap, not a fresh one from $3");
});

test("with no key yet there's nothing to refresh", async () => {
  const w = keyWorld({ spent: 0, cap: null, hash: null });
  assert.equal(await refreshAllowance(w.store, w.deps), null);
});

test("a key with allowance left is handed out; a spent or disabled one is refused", async () => {
  const w = keyWorld({ state: nextAllowance(free, null, 2), spent: 2, cap: 5 });
  refuseUnusable(await refreshAllowance(w.store, w.deps));

  // Spent to within half a cent of the period's cap: nothing left to run on.
  w.key.spent = 11.996;
  const spent = await refreshAllowance(w.store, w.deps);
  assert.throws(() => refuseUnusable(spent), AllowanceSpentError);

  w.key.spent = 3;
  w.key.disabled = true;
  const disabled = await refreshAllowance(w.store, w.deps);
  assert.throws(() => refuseUnusable(disabled), ModelKeyDisabledError);
});

test("with no allowance to judge, the key is handed out", () => {
  // No key yet, or the refresh failed: OpenRouter's own cap still holds.
  refuseUnusable(null);
});

test("an existing Max key from when Max was unlimited is capped at $50 over the period's baseline", () => {
  const before = nextAllowance(unlimited(), null, 3)!;
  assert.equal(before.limitUsd, null);
  assert.deepEqual(nextAllowance(max(), before, 20), { period: october.start.toISOString(), plan: "max", baselineUsd: 3, limitUsd: 53 });
  // One that already spent past it this period stops there until the next.
  assert.equal(nextAllowance(max(), before, 80)?.limitUsd, 80);
});

test("existing keys lose their old cap within the same period on an unlimited plan", async () => {
  const state: AllowanceState = {
    period: october.start.toISOString(),
    plan: "max",
    baselineUsd: 3,
    limitUsd: 53,
  };
  const w = keyWorld({ state, spent: 53, cap: 53 });
  w.deps.entitlements = async () => unlimited();
  const refreshed = await refreshAllowance(w.store, w.deps);
  assert.deepEqual(refreshed, { usedUsd: 50, limitUsd: null, disabled: false });
  assert.deepEqual(w.patches, [null]);
  refuseUnusable(refreshed);
  w.key.spent = 10000;
  await refreshAllowance(w.store, w.deps);
  assert.deepEqual(w.patches, [null], "an unlimited key is not patched repeatedly");
});

test("a failed removal of an existing key's cap is retried without another grant", async () => {
  const w = keyWorld({ spent: 50, cap: 50 });
  w.deps.entitlements = async () => unlimited();
  await assert.rejects(
    refreshAllowance(w.store, {
      ...w.deps,
      setLimit: async () => {
        throw new Error("offline");
      },
    }),
    /offline/,
  );
  assert.equal(w.row.state?.limitUsd, null);
  await refreshAllowance(w.store, w.deps);
  assert.deepEqual(w.patches, [null]);
});

test("downgrading from unlimited reinstates the paid or Free cap", async () => {
  const state = nextAllowance(unlimited(), null, 0)!;
  for (const entitlements of [pro(), free]) {
    const w = keyWorld({ state, spent: 200, cap: null });
    w.deps.entitlements = async () => entitlements;
    const refreshed = await refreshAllowance(w.store, w.deps);
    assert.deepEqual(w.patches, [200]);
    assert.throws(() => refuseUnusable(refreshed), AllowanceSpentError);
  }
});

test("unlimited model usage still respects a manually disabled key", async () => {
  const w = keyWorld({ spent: 1000, cap: null });
  w.deps.entitlements = async () => unlimited();
  w.key.disabled = true;
  const refreshed = await refreshAllowance(w.store, w.deps);
  assert.throws(() => refuseUnusable(refreshed), ModelKeyDisabledError);
});

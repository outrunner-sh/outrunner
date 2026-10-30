import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_FEATURE_MULTI_REPO_WARM, AGENT_FEATURE_WARM_HOOKS } from "@/lib/runtime/agent-protocol";
import {
  type PooledBox,
  projectCheckouts,
  REFILL_BACKOFF_MS,
  refillPool,
  STALE_REFILL_MS,
  wakeIntentPool,
  warmRefusal,
  type WarmPoolDeps,
} from "@/lib/runtime/warm-pool";

const NOW = Date.parse("2026-10-25T12:00:00Z");

/** A project with or without a pooled box; every step lands in `log`. */
function pool(
  opts: {
    pools?: boolean;
    existing?: PooledBox[];
    size?: number;
    generation?: number | null;
    warmFails?: boolean;
    slotTaken?: boolean;
    makeFails?: "before-box" | "after-box";
    pauseFails?: boolean;
    rowGone?: boolean;
    discardFails?: boolean;
    claimedMeanwhile?: boolean;
    oldDiscardFails?: boolean;
  } = {},
) {
  const log: string[] = [];
  const deps: WarmPoolDeps = {
    pools: opts.pools ?? true,
    provider: "daytona",
    size: opts.size ?? 1,
    generation: opts.generation === undefined ? 1 : opts.generation,
    pooled: async () => opts.existing ?? [],
    claimSlot: async (slot, secret) => {
      log.push(`slot ${slot} with ${secret}`);
      return opts.slotTaken ? null : { id: slot === 0 ? "c-1" : `c-${slot + 1}` };
    },
    warm: async (computerId, sandboxId) => {
      log.push(`warm ${sandboxId}`);
      if (opts.warmFails) throw new Error("warm hook failed");
    },
    make: async (secret, onBox) => {
      log.push(`make with ${secret}`);
      if (opts.makeFails === "before-box") throw new Error("Daytona said no");
      await onBox("sb-1");
      if (opts.makeFails === "after-box") throw new Error("clone failed");
      return { sandboxId: "sb-1" };
    },
    recordBox: async (computerId, sandboxId) => void log.push(`record ${sandboxId} on ${computerId}`),
    pause: async (sandboxId) => {
      log.push(`pause ${sandboxId}`);
      if (opts.pauseFails) throw new Error("pause failed");
    },
    ready: async (computerId, sandboxId) => {
      log.push(`ready ${computerId} on ${sandboxId}`);
      return !opts.rowGone;
    },
    failed: async (computerId, leftover) => void log.push(`failed ${computerId}${leftover ? ` keeping ${leftover}` : ""}`),
    discard: async (sandboxId, provider) => {
      log.push(`discard ${sandboxId} on ${provider}`);
      if (opts.discardFails || (opts.oldDiscardFails && sandboxId === "sb-old")) throw new Error("Daytona timed out");
    },
    forget: async (computerId) => void log.push(`forget ${computerId}`),
    leftover: async (b, sandboxId) => void log.push(`leftover ${sandboxId} in ${b.poolSlot} of gen ${b.generation} on ${b.provider}`),
    release: async (computerId) => {
      log.push(`release ${computerId}`);
      return !opts.claimedMeanwhile;
    },
    newSecret: () => "s3cret",
    now: () => NOW,
  };
  return { deps, log };
}

const box = (over: Partial<PooledBox>): PooledBox => ({
  id: "c-old",
  status: "stopped",
  provider: "daytona",
  daytonaSandboxId: "sb-old",
  updatedAt: new Date(NOW - 60_000).toISOString(),
  poolSlot: 0,
  generation: 1,
  ...over,
});

const MADE = ["slot 0 with s3cret", "make with s3cret", "record sb-1 on c-1", "warm sb-1", "pause sb-1", "ready c-1 on sb-1"];

test("a project without a pooled box gets one, its id recorded as soon as it exists", async () => {
  const { deps, log } = pool();
  assert.equal(await refillPool(deps), 1);
  assert.deepEqual(log, MADE);
});

test("a pooled box ready to take, or one being made now, is left as it is", async () => {
  for (const existing of [box({}), box({ status: "provisioning", daytonaSandboxId: null })]) {
    const { deps, log } = pool({ existing: [existing] });
    assert.equal(await refillPool(deps), 0, existing.status);
    assert.deepEqual(log, [], existing.status);
  }
});

test("a refill another started first, or a provider that can't pool: nothing is made", async () => {
  for (const opts of [{ slotTaken: true }, { pools: false }]) {
    const { deps, log } = pool(opts);
    assert.equal(await refillPool(deps), 0, JSON.stringify(opts));
    assert.equal(log.some((line) => line.startsWith("make")), false, JSON.stringify(opts));
  }
});

test("a refill that died mid-way is replaced: its box deleted, its row gone, a new one made", async () => {
  const stale = new Date(NOW - STALE_REFILL_MS - 1).toISOString();
  const { deps, log } = pool({ existing: [box({ status: "provisioning", updatedAt: stale })] });
  assert.equal(await refillPool(deps), 1);
  assert.deepEqual(log, ["release c-old", "discard sb-old on daytona", ...MADE]);

  // Cut off before its box existed: only its row.
  const early = pool({ existing: [box({ status: "provisioning", updatedAt: stale, daytonaSandboxId: null })] });
  assert.equal(await refillPool(early.deps), 1);
  assert.deepEqual(early.log, ["release c-old", ...MADE]);
});

test("a pooled box from the provider the user moved from is deleted there and replaced", async () => {
  const { deps, log } = pool({ existing: [box({ provider: "user-modal" })] });
  assert.equal(await refillPool(deps), 1);
  assert.deepEqual(log, ["release c-old", "discard sb-old on user-modal", ...MADE]);
});

test("a box that couldn't be made goes, and its row is kept failed for the back-off", async () => {
  const before = pool({ makeFails: "before-box" });
  await assert.rejects(refillPool(before.deps), /Daytona said no/);
  assert.deepEqual(before.log, ["slot 0 with s3cret", "make with s3cret", "failed c-1"]);

  const after = pool({ makeFails: "after-box" });
  await assert.rejects(refillPool(after.deps), /clone failed/);
  assert.deepEqual(after.log, [
    "slot 0 with s3cret",
    "make with s3cret",
    "record sb-1 on c-1",
    "discard sb-1 on daytona",
    "failed c-1",
  ]);
});

test("a box made but not stopped is deleted, not left running unrecorded", async () => {
  const { deps, log } = pool({ pauseFails: true });
  await assert.rejects(refillPool(deps), /pause failed/);
  assert.deepEqual(log, [...MADE.slice(0, 5), "discard sb-1 on daytona", "failed c-1"]);
});

test("a refill whose row was swept while it ran deletes its box rather than leave it unrecorded", async () => {
  const { deps, log } = pool({ rowGone: true });
  await assert.rejects(refillPool(deps), /sweep/);
  assert.deepEqual(log, [...MADE, "discard sb-1 on daytona", "failed c-1"]);
});

test("a project whose refill failed waits before the next try", async () => {
  const recent = pool({ existing: [box({ status: "error", daytonaSandboxId: null })] });
  assert.equal(await refillPool(recent.deps), 0);
  assert.deepEqual(recent.log, []);

  const old = new Date(NOW - REFILL_BACKOFF_MS - 1).toISOString();
  const later = pool({ existing: [box({ status: "error", daytonaSandboxId: null, updatedAt: old })] });
  assert.equal(await refillPool(later.deps), 1);
  assert.deepEqual(later.log, ["release c-old", ...MADE]);
});

test("a box whose delete failed stays on the failed row, and the retry deletes it", async () => {
  const { deps, log } = pool({ pauseFails: true, discardFails: true });
  await assert.rejects(refillPool(deps), /pause failed/);
  assert.equal(log.at(-1), "failed c-1 keeping sb-1");

  const old = new Date(NOW - REFILL_BACKOFF_MS - 1).toISOString();
  const retry = pool({ existing: [box({ status: "error", daytonaSandboxId: "sb-1", updatedAt: old })] });
  assert.equal(await refillPool(retry.deps), 1);
  assert.deepEqual(retry.log.slice(0, 2), ["release c-old", "discard sb-1 on daytona"]);
});

test("a project keeps two ready boxes: the free slot is filled", async () => {
  const empty = pool({ size: 2 });
  assert.equal(await refillPool(empty.deps), 2);
  assert.deepEqual(
    empty.log.filter((l) => l.startsWith("slot")),
    ["slot 0 with s3cret", "slot 1 with s3cret"],
  );

  const half = pool({ size: 2, existing: [box({ poolSlot: 0 })] });
  assert.equal(await refillPool(half.deps), 1);
  assert.deepEqual(half.log.filter((l) => l.startsWith("slot")), ["slot 1 with s3cret"]);
});

test("a box made from an older setup is replaced; one still being made is left to finish", async () => {
  const { deps, log } = pool({ generation: 2, existing: [box({ generation: 1 })] });
  assert.equal(await refillPool(deps), 1);
  assert.deepEqual(log.slice(0, 2), ["release c-old", "discard sb-old on daytona"]);

  const making = pool({ generation: 2, existing: [box({ generation: 1, status: "provisioning", daytonaSandboxId: null })] });
  assert.equal(await refillPool(making.deps), 0);
  assert.deepEqual(making.log, []);
});

test("a failed refill of an older setup is tried again at once with the new one", async () => {
  const { deps, log } = pool({ generation: 2, existing: [box({ generation: 1, status: "error", daytonaSandboxId: null })] });
  assert.equal(await refillPool(deps), 1);
  assert.deepEqual(log, ["release c-old", ...MADE]);
});

test("a warm hook that fails deletes the box and backs off", async () => {
  const { deps, log } = pool({ warmFails: true });
  await assert.rejects(refillPool(deps), /warm hook failed/);
  assert.deepEqual(log, [...MADE.slice(0, 4), "discard sb-1 on daytona", "failed c-1"]);
});

test("an outdated box a session claimed meanwhile is that session's: not deleted", async () => {
  const { deps, log } = pool({ generation: 2, existing: [box({ generation: 1 })], claimedMeanwhile: true });
  await refillPool(deps);
  assert.deepEqual(log.slice(0, 1), ["release c-old"]);
  assert.equal(log.some((l) => l.startsWith("discard")), false);
});

test("a replaced box whose delete fails is kept on a failed row for the sweeper, its slot not refilled", async () => {
  const { deps, log } = pool({ generation: 2, existing: [box({ generation: 1 })], oldDiscardFails: true });
  assert.equal(await refillPool(deps), 0);
  assert.deepEqual(log, ["release c-old", "discard sb-old on daytona", "leftover sb-old in 0 of gen 1 on daytona"]);
});

test("a ready box is warmed with the repositories a new session works on, its own from the base it was asked for", () => {
  const checkouts = [
    { projectId: "p-web", fullName: "acme/web", checkout: "web", baseBranch: "release" },
    { projectId: "p-api", fullName: "acme/api", checkout: "api", baseBranch: "develop" },
  ];
  assert.deepEqual(projectCheckouts(checkouts, "p-web", "main"), [
    { projectId: "p-web", fullName: "acme/web", checkout: "web", baseBranch: "main" },
    checkouts[1],
  ]);
  assert.equal(projectCheckouts(null, "p-web", "main"), null, "a project of one");
});

test("an agent that can't warm the project leaves its box unwarmed, and says why", () => {
  assert.equal(warmRefusal([AGENT_FEATURE_WARM_HOOKS, AGENT_FEATURE_MULTI_REPO_WARM], true), null);
  assert.equal(warmRefusal([AGENT_FEATURE_WARM_HOOKS], false), null, "one repository needs no more");
  assert.match(warmRefusal([AGENT_FEATURE_WARM_HOOKS], true) ?? "", /several repositories/);
  assert.match(warmRefusal(undefined, false) ?? "", /can't run warm hooks/);
  assert.match(warmRefusal([AGENT_FEATURE_MULTI_REPO_WARM], true) ?? "", /can't run warm hooks/);
});

test("an intent wake pauses before recording stopped when ready persistence fails", async () => {
  const log: string[] = [];
  await assert.rejects(
    wakeIntentPool({
      wake: async () => (log.push("wake"), { sandboxId: "sb-1" }),
      publish: async () => {
        log.push("publish");
        throw new Error("database unavailable");
      },
      meter: async () => void log.push("meter"),
      meterFailed: () => log.push("meter failed"),
      pause: async () => void log.push("pause"),
      stopped: async () => void log.push("stopped"),
    }),
    /database unavailable/,
  );
  assert.deepEqual(log, ["wake", "publish", "pause", "stopped"]);
});

test("an intent wake keeps its ready row when only metering fails", async () => {
  const log: string[] = [];
  assert.equal(
    await wakeIntentPool({
      wake: async () => (log.push("wake"), { sandboxId: "sb-1" }),
      publish: async () => (log.push("publish"), true),
      meter: async () => {
        log.push("meter");
        throw new Error("metering unavailable");
      },
      meterFailed: () => log.push("meter failed"),
      pause: async () => void log.push("pause"),
      stopped: async () => void log.push("stopped"),
    }),
    true,
  );
  assert.deepEqual(log, ["wake", "publish", "meter", "meter failed"]);
});

test("an expired intent lease fences a wake that completes after cleanup claims it", async () => {
  const log: string[] = [];
  let finishWake!: (restored: { sandboxId: string }) => void;
  const waking = wakeIntentPool({
    wake: () => new Promise((resolve) => {
      finishWake = resolve;
      log.push("wake started");
    }),
    // False is the compare-and-set result after cleanup clears the lease.
    publish: async () => (log.push("publish fenced"), false),
    meter: async () => void log.push("meter"),
    meterFailed: () => log.push("meter failed"),
    pause: async () => void log.push("worker pause"),
    stopped: async () => void log.push("stopped"),
  });
  log.push("cleanup claimed");
  finishWake({ sandboxId: "sb-1" });
  assert.equal(await waking, false);
  // Cleanup owns the pause; the late worker neither publishes ready nor
  // competes with it for the external box.
  log.push("cleanup pause");
  assert.deepEqual(log, ["wake started", "cleanup claimed", "publish fenced", "cleanup pause"]);
});

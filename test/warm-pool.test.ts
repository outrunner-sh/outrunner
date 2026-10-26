import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PooledBox,
  REFILL_BACKOFF_MS,
  refillPool,
  STALE_REFILL_MS,
  type WarmPoolDeps,
} from "@/lib/runtime/warm-pool";

const NOW = Date.parse("2026-10-25T12:00:00Z");

/** A project with or without a pooled box; every step lands in `log`. */
function pool(
  opts: {
    pools?: boolean;
    existing?: PooledBox;
    slotTaken?: boolean;
    makeFails?: "before-box" | "after-box";
    pauseFails?: boolean;
    rowGone?: boolean;
    discardFails?: boolean;
  } = {},
) {
  const log: string[] = [];
  const deps: WarmPoolDeps = {
    pools: opts.pools ?? true,
    provider: "daytona",
    pooled: async () => opts.existing ?? null,
    claimSlot: async (secret) => {
      log.push(`slot with ${secret}`);
      return opts.slotTaken ? null : { id: "c-1" };
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
      if (opts.discardFails) throw new Error("Daytona timed out");
    },
    forget: async (computerId) => void log.push(`forget ${computerId}`),
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
  ...over,
});

const MADE = ["slot with s3cret", "make with s3cret", "record sb-1 on c-1", "pause sb-1", "ready c-1 on sb-1"];

test("a project without a pooled box gets one, its id recorded as soon as it exists", async () => {
  const { deps, log } = pool();
  assert.equal(await refillPool(deps), true);
  assert.deepEqual(log, MADE);
});

test("a pooled box ready to take, or one being made now, is left as it is", async () => {
  for (const existing of [box({}), box({ status: "provisioning", daytonaSandboxId: null })]) {
    const { deps, log } = pool({ existing });
    assert.equal(await refillPool(deps), false, existing.status);
    assert.deepEqual(log, [], existing.status);
  }
});

test("a refill another started first, or a provider that can't pool: nothing is made", async () => {
  for (const opts of [{ slotTaken: true }, { pools: false }]) {
    const { deps, log } = pool(opts);
    assert.equal(await refillPool(deps), false, JSON.stringify(opts));
    assert.equal(log.some((line) => line.startsWith("make")), false, JSON.stringify(opts));
  }
});

test("a refill that died mid-way is replaced: its box deleted, its row gone, a new one made", async () => {
  const stale = new Date(NOW - STALE_REFILL_MS - 1).toISOString();
  const { deps, log } = pool({ existing: box({ status: "provisioning", updatedAt: stale }) });
  assert.equal(await refillPool(deps), true);
  assert.deepEqual(log, ["discard sb-old on daytona", "forget c-old", ...MADE]);

  // Cut off before its box existed: only its row.
  const early = pool({ existing: box({ status: "provisioning", updatedAt: stale, daytonaSandboxId: null }) });
  assert.equal(await refillPool(early.deps), true);
  assert.deepEqual(early.log, ["forget c-old", ...MADE]);
});

test("a pooled box from the provider the user moved from is deleted there and replaced", async () => {
  const { deps, log } = pool({ existing: box({ provider: "user-modal" }) });
  assert.equal(await refillPool(deps), true);
  assert.deepEqual(log, ["discard sb-old on user-modal", "forget c-old", ...MADE]);
});

test("a box that couldn't be made goes, and its row is kept failed for the back-off", async () => {
  const before = pool({ makeFails: "before-box" });
  await assert.rejects(refillPool(before.deps), /Daytona said no/);
  assert.deepEqual(before.log, ["slot with s3cret", "make with s3cret", "failed c-1"]);

  const after = pool({ makeFails: "after-box" });
  await assert.rejects(refillPool(after.deps), /clone failed/);
  assert.deepEqual(after.log, [
    "slot with s3cret",
    "make with s3cret",
    "record sb-1 on c-1",
    "discard sb-1 on daytona",
    "failed c-1",
  ]);
});

test("a box made but not stopped is deleted, not left running unrecorded", async () => {
  const { deps, log } = pool({ pauseFails: true });
  await assert.rejects(refillPool(deps), /pause failed/);
  assert.deepEqual(log, [...MADE.slice(0, 4), "discard sb-1 on daytona", "failed c-1"]);
});

test("a refill whose row was swept while it ran deletes its box rather than leave it unrecorded", async () => {
  const { deps, log } = pool({ rowGone: true });
  await assert.rejects(refillPool(deps), /sweep/);
  assert.deepEqual(log, [...MADE, "discard sb-1 on daytona", "failed c-1"]);
});

test("a project whose refill failed waits before the next try", async () => {
  const recent = pool({ existing: box({ status: "error", daytonaSandboxId: null }) });
  assert.equal(await refillPool(recent.deps), false);
  assert.deepEqual(recent.log, []);

  const old = new Date(NOW - REFILL_BACKOFF_MS - 1).toISOString();
  const later = pool({ existing: box({ status: "error", daytonaSandboxId: null, updatedAt: old }) });
  assert.equal(await refillPool(later.deps), true);
  assert.deepEqual(later.log, ["forget c-old", ...MADE]);
});

test("a box whose delete failed stays on the failed row, and the retry deletes it", async () => {
  const { deps, log } = pool({ pauseFails: true, discardFails: true });
  await assert.rejects(refillPool(deps), /pause failed/);
  assert.equal(log.at(-1), "failed c-1 keeping sb-1");

  const old = new Date(NOW - REFILL_BACKOFF_MS - 1).toISOString();
  const retry = pool({ existing: box({ status: "error", daytonaSandboxId: "sb-1", updatedAt: old }) });
  assert.equal(await refillPool(retry.deps), true);
  assert.deepEqual(retry.log.slice(0, 2), ["discard sb-1 on daytona", "forget c-old"]);
});

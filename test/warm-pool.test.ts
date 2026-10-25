import assert from "node:assert/strict";
import { test } from "node:test";

import { refillPool, type WarmPoolDeps } from "@/lib/runtime/warm-pool";

/** A project with or without a pooled box; every step lands in `log`. */
function pool(opts: { pools?: boolean; has?: boolean; slotTaken?: boolean; makeFails?: boolean; pauseFails?: boolean } = {}) {
  const log: string[] = [];
  const deps: WarmPoolDeps = {
    pools: opts.pools ?? true,
    pooled: async () => (opts.has ? { id: "c-old" } : null),
    claimSlot: async (secret) => {
      log.push(`slot with ${secret}`);
      return opts.slotTaken ? null : { id: "c-1" };
    },
    make: async (secret) => {
      log.push(`make with ${secret}`);
      if (opts.makeFails) throw new Error("Daytona said no");
      return { sandboxId: "sb-1" };
    },
    pause: async (sandboxId) => {
      log.push(`pause ${sandboxId}`);
      if (opts.pauseFails) throw new Error("pause failed");
    },
    ready: async (computerId, sandboxId) => void log.push(`ready ${computerId} on ${sandboxId}`),
    discard: async (sandboxId) => void log.push(`discard ${sandboxId}`),
    forget: async (computerId) => void log.push(`forget ${computerId}`),
    newSecret: () => "s3cret",
  };
  return { deps, log };
}

test("a project without a pooled box gets one made ready, then stopped", async () => {
  const { deps, log } = pool();
  assert.equal(await refillPool(deps), true);
  assert.deepEqual(log, ["slot with s3cret", "make with s3cret", "pause sb-1", "ready c-1 on sb-1"]);
});

test("one there already, a refill started first, or a provider that can't pool: nothing is made", async () => {
  for (const opts of [{ has: true }, { slotTaken: true }, { pools: false }]) {
    const { deps, log } = pool(opts);
    assert.equal(await refillPool(deps), false, JSON.stringify(opts));
    assert.equal(log.some((line) => line.startsWith("make")), false, JSON.stringify(opts));
  }
});

test("a box that couldn't be made leaves no row behind", async () => {
  const { deps, log } = pool({ makeFails: true });
  await assert.rejects(refillPool(deps), /Daytona said no/);
  assert.deepEqual(log, ["slot with s3cret", "make with s3cret", "forget c-1"]);
});

test("a box made but not stopped is deleted, not left running unrecorded", async () => {
  const { deps, log } = pool({ pauseFails: true });
  await assert.rejects(refillPool(deps), /pause failed/);
  assert.deepEqual(log, ["slot with s3cret", "make with s3cret", "pause sb-1", "discard sb-1", "forget c-1"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentEndpointCache } from "@/lib/runtime/agent-endpoint-cache";
import type { AgentEndpoint } from "@/lib/runtime/sandbox/backend";

const endpoint = (n: number): AgentEndpoint => ({
  controlBaseUrl: `https://box/${n}`,
  controlHeaders: { token: `t${n}` },
  wsBaseUrl: `wss://box/${n}`,
});

/** A cache on a clock the test moves, and a lookup that counts its calls. */
function setup(ttlMs = 1000) {
  let now = 0;
  const cache = new AgentEndpointCache({ ttlMs, now: () => now });
  let calls = 0;
  const load = () => Promise.resolve(endpoint(++calls));
  return {
    cache,
    load,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("within its lifetime a box's endpoint is reused, without asking the provider", async () => {
  const { cache, load, calls, advance } = setup();
  assert.deepEqual(await cache.get("daytona:a", load), endpoint(1));
  advance(999);
  assert.deepEqual(await cache.get("daytona:a", load), endpoint(1));
  assert.equal(calls(), 1);
});

test("once its lifetime is up it is looked up again", async () => {
  const { cache, load, calls, advance } = setup();
  await cache.get("daytona:a", load);
  advance(1000);
  assert.deepEqual(await cache.get("daytona:a", load), endpoint(2));
  assert.equal(calls(), 2);
});

test("the default lifetime ends before Daytona's 5-minute signed URL does", () => {
  // A URL handed out at the end of its lifetime must still be openable.
  const fiveMinutes = 5 * 60_000;
  let now = 0;
  const cache = new AgentEndpointCache({ now: () => now });
  let calls = 0;
  const load = () => Promise.resolve(endpoint(++calls));
  void cache.get("daytona:a", load);
  now = fiveMinutes - 60_000;
  void cache.get("daytona:a", load);
  assert.equal(calls, 2);
});

test("each box has its own: a new box never gets an old box's endpoint", async () => {
  const { cache, load, calls } = setup();
  await cache.get("daytona:old", load);
  assert.deepEqual(await cache.get("daytona:new", load), endpoint(2));
  assert.deepEqual(await cache.get("modal:old", load), endpoint(3));
  assert.equal(calls(), 3);
});

test("lookups at the same time share one call to the provider", async () => {
  const { cache, load, calls } = setup();
  const [a, b] = await Promise.all([cache.get("daytona:a", load), cache.get("daytona:a", load)]);
  assert.equal(a, b);
  assert.equal(calls(), 1);
});

test("a failed lookup is not kept: the next caller asks again", async () => {
  const { cache, calls, load } = setup();
  await assert.rejects(cache.get("daytona:a", () => Promise.reject(new Error("provider down"))));
  assert.deepEqual(await cache.get("daytona:a", load), endpoint(1));
  assert.equal(calls(), 1);
});

test("a failure doesn't drop the newer lookup that replaced it", async () => {
  const { cache, load, calls } = setup();
  let fail!: (error: Error) => void;
  const failing = cache.get("daytona:a", () => new Promise((_, reject) => (fail = reject)));
  const fresh = await cache.get("daytona:a", load, { fresh: true });
  fail(new Error("late failure"));
  await assert.rejects(failing);
  assert.equal(await cache.get("daytona:a", load), fresh);
  assert.equal(calls(), 1);
});

test("fresh skips what is kept, after a connection to it failed, and keeps the new answer", async () => {
  const { cache, load, calls } = setup();
  await cache.get("daytona:a", load);
  assert.deepEqual(await cache.get("daytona:a", load, { fresh: true }), endpoint(2));
  assert.deepEqual(await cache.get("daytona:a", load), endpoint(2));
  assert.equal(calls(), 2);
});

test("forget drops a box's endpoint", async () => {
  const { cache, load, calls } = setup();
  await cache.get("daytona:a", load);
  cache.forget("daytona:a");
  await cache.get("daytona:a", load);
  assert.equal(calls(), 2);
});

test("endpoints of boxes no longer asked for are dropped once their lifetime is up", async () => {
  // One box per session: most keys are never looked up again.
  const { cache, load, advance } = setup();
  for (let i = 0; i < 50; i++) await cache.get(`daytona:s${i}`, load);
  assert.equal(cache.size, 50);
  advance(500);
  await cache.get("daytona:recent", load);
  // None expired yet: all are kept.
  assert.equal(cache.size, 51);
  advance(500);
  await cache.get("daytona:new", load);
  // The fifty are past their lifetime; the recent one and the new one stay.
  assert.equal(cache.size, 2);
  assert.deepEqual(await cache.get("daytona:recent", load), endpoint(51));
});

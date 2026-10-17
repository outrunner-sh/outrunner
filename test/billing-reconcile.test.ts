import assert from "node:assert/strict";
import { test } from "node:test";

import type { MeteredComputer, OpenInterval } from "@/lib/billing/metering-store";
import { type BoxState, IDLE_AFTER_MS, isIdle, reconcile, STUCK_TURN_AFTER_MS } from "@/lib/billing/reconcile";

const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

function computer(id: string): MeteredComputer {
  return { id, ownerId: "u-1", projectId: `p-${id}`, sandboxId: `sb-${id}`, agentSecret: "s" };
}
function interval(id: string, sandboxId: string, lastSeenMinutesAgo = 2): OpenInterval {
  return { id, sandboxId, startedAt: new Date(ago(60 * MIN)), lastSeenAt: new Date(ago(lastSeenMinutesAgo * MIN)) };
}
const active: BoxState = { running: true, activity: { lastActivity: ago(1 * MIN), turnInProgress: false } };
const idle: BoxState = { running: true, activity: { lastActivity: ago(20 * MIN), turnInProgress: false } };

/** A world of computers, their boxes' states, and open intervals; every
 *  write lands in `log`. */
function world(opts: {
  computers: MeteredComputer[];
  states: Record<string, BoxState | Error>;
  open?: OpenInterval[];
  lease?: boolean;
}) {
  const log: string[] = [];
  const deps = {
    now: () => NOW,
    claimLease: async () => opts.lease ?? true,
    readyComputers: async () => opts.computers,
    openIntervals: async () => opts.open ?? [],
    observe: async (c: MeteredComputer) => {
      const state = opts.states[c.id];
      if (state instanceof Error) throw state;
      return state;
    },
    pause: async (c: MeteredComputer) => void log.push(`pause ${c.sandboxId}`),
    markStopped: async (c: MeteredComputer) => void log.push(`stopped ${c.id}`),
    openInterval: async (c: MeteredComputer, at: Date) => void log.push(`open ${c.sandboxId} at ${at.toISOString()}`),
    touchIntervals: async (ids: string[]) => void (ids.length && log.push(`seen ${ids.sort().join(",")}`)),
    closeInterval: async (id: string, at: Date) => void log.push(`close ${id} at ${at.toISOString()}`),
    log: () => {},
  };
  return { deps, log };
}

test("idle is 15 quiet minutes, or 2 hours with a turn that never ended", () => {
  assert.equal(isIdle({ lastActivity: ago(IDLE_AFTER_MS - MIN), turnInProgress: false }, NOW), false);
  assert.equal(isIdle({ lastActivity: ago(IDLE_AFTER_MS), turnInProgress: false }, NOW), true);
  // A long, quiet tool run (a test suite) isn't idle...
  assert.equal(isIdle({ lastActivity: ago(60 * MIN), turnInProgress: true }, NOW), false);
  // ...but a turn left open for hours (Claude killed mid-turn) is.
  assert.equal(isIdle({ lastActivity: ago(STUCK_TURN_AFTER_MS), turnInProgress: true }, NOW), true);
  // An agent that couldn't say, or said nonsense, is never paused.
  assert.equal(isIdle(null, NOW), false);
  assert.equal(isIdle({ lastActivity: "not a date", turnInProgress: false }, NOW), false);
});

test("a busy box is seen; one with no interval gets one", async () => {
  const { deps, log } = world({
    computers: [computer("a"), computer("b")],
    states: { a: active, b: active },
    open: [interval("i-a", "sb-a")],
  });
  const report = await reconcile(deps);
  assert.deepEqual(log.sort(), [`open sb-b at ${NOW.toISOString()}`, "seen i-a"]);
  assert.deepEqual(report, { skipped: false, seen: 2, paused: 0, lost: 0, closed: 0, failed: 0 });
});

test("an idle box is paused, its interval ends now, and the computer stops", async () => {
  const { deps, log } = world({ computers: [computer("a")], states: { a: idle }, open: [interval("i-a", "sb-a")] });
  const report = await reconcile(deps);
  assert.deepEqual(log, ["pause sb-a", `close i-a at ${NOW.toISOString()}`, "stopped a"]);
  assert.equal(report.paused, 1);
});

test("a box that stopped unseen ends its interval where it was last seen, not now", async () => {
  const { deps, log } = world({
    computers: [computer("a")],
    states: { a: { running: false } },
    open: [interval("i-a", "sb-a", 7)],
  });
  const report = await reconcile(deps);
  assert.deepEqual(log, [`close i-a at ${ago(7 * MIN)}`, "stopped a"]);
  assert.equal(report.lost, 1);
});

test("an interval for a box no ready computer has is closed where it was last seen", async () => {
  const { deps, log } = world({ computers: [], states: {}, open: [interval("i-gone", "sb-gone", 3)] });
  const report = await reconcile(deps);
  assert.deepEqual(log, [`close i-gone at ${ago(3 * MIN)}`]);
  assert.equal(report.closed, 1);
});

test("one box failing doesn't stop the others, and its interval is left as it was", async () => {
  const { deps, log } = world({
    computers: [computer("a"), computer("b")],
    states: { a: new Error("provider down"), b: active },
    open: [interval("i-a", "sb-a"), interval("i-b", "sb-b")],
  });
  const report = await reconcile(deps);
  // i-a is neither touched nor closed: counted no further than last seen.
  assert.deepEqual(log, ["seen i-b"]);
  assert.equal(report.failed, 1);
  assert.equal(report.seen, 1);
});

test("an agent that can't report activity keeps its box running and metered", async () => {
  const { deps, log } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [interval("i-a", "sb-a")],
  });
  await reconcile(deps);
  assert.deepEqual(log, ["seen i-a"]);
});

test("with the lease held elsewhere, the run does nothing", async () => {
  const { deps, log } = world({ computers: [computer("a")], states: { a: idle }, lease: false });
  assert.equal((await reconcile(deps)).skipped, true);
  assert.deepEqual(log, []);
});

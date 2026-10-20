import assert from "node:assert/strict";
import { test } from "node:test";

import type { MeteredComputer, OpenInterval } from "@/lib/billing/metering-store";
import {
  type BoxState,
  IDLE_AFTER_MS,
  isIdle,
  reconcile,
  RUN_DEADLINE_MS,
  STUCK_TURN_AFTER_MS,
  trustedActivity,
  UNKNOWN_ACTIVITY_AFTER_MS,
} from "@/lib/billing/reconcile";

const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

function computer(id: string): MeteredComputer {
  return { id, ownerId: "u-1", projectId: `p-${id}`, sandboxId: `sb-${id}`, agentSecret: "s" };
}
function interval(id: string, sandboxId: string, lastSeenMinutesAgo = 2): OpenInterval {
  return {
    id,
    sandboxId,
    startedAt: new Date(ago(60 * MIN)),
    lastSeenAt: new Date(ago(lastSeenMinutesAgo * MIN)),
    activityUnknownSince: null,
  };
}
const active: BoxState = { running: true, activity: { lastActivity: ago(1 * MIN), turnInProgress: false } };
const idle: BoxState = { running: true, activity: { lastActivity: ago(20 * MIN), turnInProgress: false } };

/** A world of computers, their boxes' states, and open intervals; every
 *  write lands in `log`. */
function world(opts: {
  computers: MeteredComputer[];
  states: Record<string, BoxState | Error | BoxState[]>;
  open?: OpenInterval[];
  lease?: boolean;
  now?: () => Date;
  pauses?: boolean;
  keepAliveFails?: boolean;
}) {
  const log: string[] = [];
  const deps = {
    pausesIdleBoxes: opts.pauses ?? true,
    now: opts.now ?? (() => NOW),
    claimLease: async () => opts.lease ?? true,
    readyComputers: async () => opts.computers,
    openIntervals: async () => opts.open ?? [],
    observe: async (c: MeteredComputer) => {
      log.push(`look ${c.id}`);
      const state = opts.states[c.id];
      if (state instanceof Error) throw state;
      // A list: what each look in turn finds.
      return Array.isArray(state) ? (state.shift() ?? state[0]) : state;
    },
    pause: async (c: MeteredComputer) => void log.push(`pause ${c.sandboxId}`),
    markStopped: async (c: MeteredComputer) => void log.push(`stopped ${c.id}`),
    openInterval: async (c: MeteredComputer, at: Date) => void log.push(`open ${c.sandboxId} at ${at.toISOString()}`),
    touchIntervals: async (ids: string[]) => void (ids.length && log.push(`seen ${ids.sort().join(",")}`)),
    closeInterval: async (id: string, at: Date) => void log.push(`close ${id} at ${at.toISOString()}`),
    markActivityUnknown: async (id: string, since: Date | null) =>
      void log.push(since ? `unknown ${id} since ${since.toISOString()}` : `known ${id}`),
    keepAlive: async (c: MeteredComputer) => {
      log.push(`keep ${c.sandboxId}`);
      if (opts.keepAliveFails) throw new Error("provider refused");
    },
    log: () => {},
  };
  // What was done, without the looks or the provider renewals.
  const writes = () => log.filter((line) => !line.startsWith("look ") && !line.startsWith("keep "));
  const kept = () => log.filter((line) => line.startsWith("keep ")).sort();
  return { deps, log: { writes, kept, all: log } };
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
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b")],
    states: { a: active, b: active },
    open: [interval("i-a", "sb-a")],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes().sort(), [`open sb-b at ${NOW.toISOString()}`, "seen i-a"]);
  assert.deepEqual(report, { skipped: false, seen: 2, paused: 0, lost: 0, closed: 0, failed: 0, deferred: 0 });
});

test("an idle box is paused, its interval ends now, and the computer stops", async () => {
  const { deps, log: logs } = world({ computers: [computer("a")], states: { a: idle }, open: [interval("i-a", "sb-a")] });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["pause sb-a", `close i-a at ${NOW.toISOString()}`, "stopped a"]);
  assert.equal(report.paused, 1);
});

test("a box that stopped unseen ends its interval where it was last seen, not now", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: false } },
    open: [interval("i-a", "sb-a", 7)],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), [`close i-a at ${ago(7 * MIN)}`, "stopped a"]);
  assert.equal(report.lost, 1);
});

test("an interval for a box no ready computer has is closed where it was last seen", async () => {
  const { deps, log: logs } = world({ computers: [], states: {}, open: [interval("i-gone", "sb-gone", 3)] });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), [`close i-gone at ${ago(3 * MIN)}`]);
  assert.equal(report.closed, 1);
});

test("one box failing doesn't stop the others, and its interval is left as it was", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b")],
    states: { a: new Error("provider down"), b: active },
    open: [interval("i-a", "sb-a"), interval("i-b", "sb-b")],
  });
  const report = await reconcile(deps);
  // i-a is neither touched nor closed: counted no further than last seen.
  assert.deepEqual(logs.writes(), ["seen i-b"]);
  assert.equal(report.failed, 1);
  assert.equal(report.seen, 1);
});

test("an agent that can't report activity keeps its box running and metered, and the run remembers when it went quiet", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [interval("i-a", "sb-a")],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), [`unknown i-a since ${NOW.toISOString()}`, "seen i-a"]);
  assert.equal(report.paused, 0);
});

test("an agent that can't report activity for 15 minutes is taken as idle, and its box paused", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [{ ...interval("i-a", "sb-a"), activityUnknownSince: new Date(ago(UNKNOWN_ACTIVITY_AFTER_MS)) }],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["pause sb-a", `close i-a at ${NOW.toISOString()}`, "stopped a"]);
  assert.equal(report.paused, 1);
});

test("an agent quiet for less than 15 minutes is left running", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [{ ...interval("i-a", "sb-a"), activityUnknownSince: new Date(ago(UNKNOWN_ACTIVITY_AFTER_MS - MIN)) }],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
  assert.equal(report.paused, 0);
});

test("an agent that answers again clears the mark, so one network blip never adds up to a pause", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: active },
    open: [{ ...interval("i-a", "sb-a"), activityUnknownSince: new Date(ago(10 * MIN)) }],
  });
  await reconcile(deps);
  assert.deepEqual(logs.writes(), ["known i-a", "seen i-a"]);
});

test("an agent that answers just before the pause keeps its box", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: [{ running: true, activity: null }, active] },
    open: [{ ...interval("i-a", "sb-a"), activityUnknownSince: new Date(ago(UNKNOWN_ACTIVITY_AFTER_MS)) }],
  });
  const report = await reconcile(deps);
  assert.equal(report.paused, 0);
  assert.ok(!logs.writes().includes("pause sb-a"));
});

test("a lastActivity in the future is not trusted: the box counts as unknown, not busy", async () => {
  const future: BoxState = { running: true, activity: { lastActivity: ago(-2 * 60 * MIN), turnInProgress: false } };
  assert.equal(trustedActivity(future.running ? future.activity : null, NOW), null);
  // Within a minute is clock skew, not a lie.
  const skewed = { lastActivity: ago(-30_000), turnInProgress: false };
  assert.deepEqual(trustedActivity(skewed, NOW), skewed);

  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: future },
    open: [{ ...interval("i-a", "sb-a"), activityUnknownSince: new Date(ago(UNKNOWN_ACTIVITY_AFTER_MS)) }],
  });
  const report = await reconcile(deps);
  assert.equal(report.paused, 1);
  assert.ok(logs.writes().includes("pause sb-a"));
});

test("every box the run keeps up has its provider backstop renewed; paused and lost ones don't", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b"), computer("c"), computer("d")],
    states: { a: active, b: idle, c: { running: false }, d: { running: true, activity: null } },
    open: [interval("i-a", "sb-a"), interval("i-b", "sb-b"), interval("i-c", "sb-c")],
  });
  await reconcile(deps);
  // d has no interval yet and an unknown agent: kept for now, so renewed.
  assert.deepEqual(logs.kept(), ["keep sb-a", "keep sb-d"]);
});

test("a renewal the provider refuses doesn't fail the box or the run", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: active },
    open: [interval("i-a", "sb-a")],
    keepAliveFails: true,
  });
  const report = await reconcile(deps);
  assert.equal(report.failed, 0);
  assert.equal(report.seen, 1);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
});

test("where paused boxes can't come back (jcode), nothing is renewed and no unknown agent is paused", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [{ ...interval("i-a", "sb-a"), activityUnknownSince: new Date(ago(UNKNOWN_ACTIVITY_AFTER_MS)) }],
    pauses: false,
  });
  const report = await reconcile(deps);
  assert.equal(report.paused, 0);
  assert.deepEqual(logs.kept(), []);
});

test("with the lease held elsewhere, the run does nothing", async () => {
  const { deps, log: logs } = world({ computers: [computer("a")], states: { a: idle }, lease: false });
  assert.equal((await reconcile(deps)).skipped, true);
  assert.deepEqual(logs.writes(), []);
});

test("a box someone starts on just before its pause is left running", async () => {
  // Idle when first looked at, busy when asked again just before pausing.
  const { deps, log: logs } = world({ computers: [computer("a")], states: { a: [idle, active] }, open: [interval("i-a", "sb-a")] });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
  assert.equal(report.paused, 0);
});

test("a run out of time leaves the rest for the next, without closing their intervals", async () => {
  let clock = NOW.getTime();
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b"), computer("c"), computer("d"), computer("e"), computer("f")],
    states: { a: active, b: active, c: active, d: active, e: active, f: active },
    open: ["a", "b", "c", "d", "e", "f"].map((id) => interval(`i-${id}`, `sb-${id}`)),
    // Each look at the clock is a while later: past the deadline after the first few.
    now: () => new Date((clock += RUN_DEADLINE_MS / 6)),
  });
  const report = await reconcile(deps);
  assert.ok(report.deferred > 0, "some boxes are left for the next run");
  assert.equal(report.seen + report.deferred, 6);
  assert.equal(report.closed, 0, "a deferred box's interval isn't taken for an orphan");
  assert.ok(!logs.writes().some((line) => line.startsWith("close")));
});

test("boxes are looked at longest unseen first, so a run out of time doesn't skip the same ones every time", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b"), computer("c")],
    states: { a: active, b: active, c: active },
    // b was seen 9 minutes ago, a 2; c has no interval yet: never seen.
    open: [interval("i-a", "sb-a", 2), interval("i-b", "sb-b", 9)],
  });
  await reconcile(deps);
  assert.deepEqual(logs.all.filter((line) => line.startsWith("look ")), ["look c", "look b", "look a"]);
});

test("where paused boxes can't come back (jcode), idle boxes are still metered, not paused", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: idle },
    open: [interval("i-a", "sb-a")],
    pauses: false,
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
  assert.equal(report.paused, 0);
  assert.equal(report.seen, 1);
});

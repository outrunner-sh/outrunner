import assert from "node:assert/strict";
import { test } from "node:test";

import type { MeteredComputer, OpenInterval } from "@/lib/billing/metering-store";
import {
  type BoxState,
  FORCED_PAUSE_NOTICE_PREFIX,
  forcedPause,
  IDLE_AFTER_MS,
  isIdle,
  MAX_BOX_RUN_HARD_MS,
  MAX_BOX_RUN_MS,
  reconcile,
  RUN_DEADLINE_MS,
  STUCK_TURN_PAUSE_MS,
  UNREACHABLE_PAUSE_MS,
} from "@/lib/billing/reconcile";

const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

function computer(id: string): MeteredComputer {
  return { id, ownerId: "u-1", projectId: `p-${id}`, workspaceId: `w-${id}`, sandboxId: `sb-${id}`, agentSecret: "s" };
}
function interval(
  id: string,
  sandboxId: string,
  lastSeenMinutesAgo = 2,
  run: { startedMinutesAgo?: number; agentSeenMinutesAgo?: number | null } = {},
): OpenInterval {
  return {
    id,
    sandboxId,
    startedAt: new Date(ago((run.startedMinutesAgo ?? 60) * MIN)),
    lastSeenAt: new Date(ago(lastSeenMinutesAgo * MIN)),
    ...(run.agentSeenMinutesAgo !== undefined && {
      agentSeenAt: run.agentSeenMinutesAgo === null ? null : new Date(ago(run.agentSeenMinutesAgo * MIN)),
    }),
  };
}
const HOUR = 60 * MIN;
const active: BoxState = { running: true, activity: { lastActivity: ago(1 * MIN), turnTrackingVersion: 1, turnInProgress: false } };
const idle: BoxState = { running: true, activity: { lastActivity: ago(20 * MIN), turnTrackingVersion: 1, turnInProgress: false } };

/** A world of computers, their boxes' states, and open intervals; every
 *  write lands in `log`. */
function world(opts: {
  computers: MeteredComputer[];
  states: Record<string, BoxState | Error | BoxState[]>;
  open?: OpenInterval[];
  lease?: boolean;
  now?: () => Date;
  pauses?: boolean;
}) {
  const log: string[] = [];
  const [reasons, notices, cleared, alive, answered, logged] = [[], [], [], [], [], []] as string[][];
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
    markStopped: async (c: MeteredComputer, reason: string) => {
      log.push(`stopped ${c.id}`);
      reasons.push(reason);
    },
    noticeSession: async (c: MeteredComputer, notice: string) => void notices.push(`${c.workspaceId}: ${notice}`),
    clearNotices: async (cs: MeteredComputer[]) => void cleared.push(...cs.map((c) => c.workspaceId!)),
    keepAlive: async (c: MeteredComputer) => void alive.push(c.sandboxId),
    openInterval: async (c: MeteredComputer, at: Date) => void log.push(`open ${c.sandboxId} at ${at.toISOString()}`),
    touchIntervals: async (ids: string[], _at: Date, ans: string[]) => {
      if (ids.length) log.push(`seen ${ids.sort().join(",")}`);
      answered.push(...ans);
    },
    closeInterval: async (id: string, at: Date) => void log.push(`close ${id} at ${at.toISOString()}`),
    log: (message: string) => void logged.push(message),
  };
  // What was done, without the looks.
  const writes = () => log.filter((line) => !line.startsWith("look "));
  return { deps, log: { writes, all: log, reasons, notices, cleared, alive, answered, logged } };
}

test("only completed turns become idle after 15 quiet minutes", () => {
  assert.equal(isIdle({ lastActivity: ago(IDLE_AFTER_MS - MIN), turnTrackingVersion: 1, turnInProgress: false }, NOW), false);
  assert.equal(isIdle({ lastActivity: ago(IDLE_AFTER_MS), turnTrackingVersion: 1, turnInProgress: false }, NOW), true);
  // Quiet execution and user absence never turn unfinished work into idle.
  assert.equal(isIdle({ lastActivity: ago(60 * MIN), turnTrackingVersion: 1, turnInProgress: true }, NOW), false);
  for (const hours of [2, 24, 168]) {
    assert.equal(isIdle({ lastActivity: ago(hours * 60 * MIN), turnTrackingVersion: 1, turnInProgress: true }, NOW), false);
  }
  // An old agent cannot reliably distinguish commentary from a final answer.
  assert.equal(isIdle({ lastActivity: ago(24 * 60 * MIN), turnInProgress: false }, NOW), false);
  // An agent that couldn't say, or said nonsense, is never paused.
  assert.equal(isIdle(null, NOW), false);
  assert.equal(isIdle({ lastActivity: "not a date", turnTrackingVersion: 1, turnInProgress: false }, NOW), false);
});

test("a busy box is seen; one with no interval gets one", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b")],
    states: { a: active, b: active },
    open: [interval("i-a", "sb-a")],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes().sort(), [`open sb-b at ${NOW.toISOString()}`, "seen i-a"]);
  assert.deepEqual(report, { skipped: false, seen: 2, paused: 0, forced: 0, lost: 0, closed: 0, failed: 0, deferred: 0 });
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

test("an agent that can't report activity keeps its box running and metered", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [interval("i-a", "sb-a")],
  });
  await reconcile(deps);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
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

test("unfinished work stays running and metered for hours without output, but not past the stuck-turn limit", async () => {
  const busyFor = (ms: number): BoxState => ({
    running: true,
    activity: { lastActivity: ago(ms), turnTrackingVersion: 1, turnInProgress: true },
  });
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: busyFor(STUCK_TURN_PAUSE_MS - MIN) },
    open: [interval("i-a", "sb-a")],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
  assert.equal(report.paused, 0);

  // Completion makes the same box eligible for the ordinary idle policy.
  deps.observe = async () => ({ running: true, activity: { lastActivity: ago(2 * HOUR), turnTrackingVersion: 1, turnInProgress: false } });
  const idleReport = await reconcile(deps);
  assert.equal(idleReport.paused, 1);
  assert.equal(idleReport.forced, 0);
});

test("forcedPause: the run's hard cap, an agent silent for hours, a turn that never ends", () => {
  const run = (startedMs: number, agentSeenMs?: number | null) => ({
    startedAt: new Date(ago(startedMs)),
    ...(agentSeenMs !== undefined && { agentSeenAt: agentSeenMs === null ? null : new Date(ago(agentSeenMs)) }),
  });
  const working = { lastActivity: ago(MIN), turnTrackingVersion: 1, turnInProgress: true };
  // A box seen for the first time has no run yet: never forced.
  assert.equal(forcedPause(null, undefined, NOW), null);
  // The run cap: held off while the box is in use (activity in the last
  // 15 minutes), up to the hard cap, past which even a busy turn is cut.
  const quietTurn = { lastActivity: ago(IDLE_AFTER_MS), turnTrackingVersion: 1, turnInProgress: true };
  assert.equal(forcedPause(quietTurn, run(MAX_BOX_RUN_MS - MIN, 0), NOW), null);
  assert.equal(forcedPause(quietTurn, run(MAX_BOX_RUN_MS, 0), NOW)?.reason, "max-run");
  assert.equal(forcedPause(null, run(MAX_BOX_RUN_MS), NOW)?.reason, "max-run");
  assert.equal(forcedPause(working, run(MAX_BOX_RUN_MS, 0), NOW), null);
  assert.equal(forcedPause(working, run(MAX_BOX_RUN_HARD_MS - MIN, 0), NOW), null);
  assert.equal(forcedPause(working, run(MAX_BOX_RUN_HARD_MS, 0), NOW)?.reason, "max-run");
  assert.match(forcedPause(working, run(MAX_BOX_RUN_HARD_MS, 0), NOW)!.notice, /after 16 hours/);
  // An agent from before /activity answers (404) without a reading: not
  // unreachable, and only the run cap stops it.
  assert.equal(forcedPause(null, run(5 * HOUR, null), NOW, true), null);
  assert.equal(forcedPause(null, run(MAX_BOX_RUN_MS, null), NOW, true)?.reason, "max-run");
  // Unreachable: from its agent's last answer, or the run's start if none.
  assert.equal(forcedPause(null, run(5 * HOUR, UNREACHABLE_PAUSE_MS - MIN), NOW), null);
  assert.equal(forcedPause(null, run(5 * HOUR, UNREACHABLE_PAUSE_MS), NOW)?.reason, "unreachable");
  assert.equal(forcedPause(null, run(UNREACHABLE_PAUSE_MS - MIN, null), NOW), null);
  assert.equal(forcedPause(null, run(UNREACHABLE_PAUSE_MS, null), NOW)?.reason, "unreachable");
  // An answer that's nonsense is no answer.
  const nonsense = { lastActivity: "not a date", turnTrackingVersion: 1, turnInProgress: true };
  assert.equal(forcedPause(nonsense, run(5 * HOUR, null), NOW)?.reason, "unreachable");
  // Not recorded (a database from before agent_seen_at): off, never measured
  // from the run's start.
  assert.equal(forcedPause(null, run(11 * HOUR), NOW), null);
  // Stuck: in a turn, or an older agent that can't say, with nothing for hours.
  const quiet = (ms: number, extra: object = { turnTrackingVersion: 1, turnInProgress: true }) => ({ lastActivity: ago(ms), turnInProgress: false, ...extra });
  assert.equal(forcedPause(quiet(STUCK_TURN_PAUSE_MS - MIN), run(7 * HOUR, 0), NOW), null);
  assert.equal(forcedPause(quiet(STUCK_TURN_PAUSE_MS), run(7 * HOUR, 0), NOW)?.reason, "stuck-turn");
  assert.equal(forcedPause(quiet(STUCK_TURN_PAUSE_MS, {}), run(7 * HOUR, 0), NOW)?.reason, "stuck-turn");
  // Every notice says why, and starts with the prefix the session shows.
  for (const forced of [
    forcedPause(quietTurn, run(MAX_BOX_RUN_MS, 0), NOW),
    forcedPause(null, run(5 * HOUR, null), NOW),
    forcedPause(quiet(STUCK_TURN_PAUSE_MS), run(7 * HOUR, 0), NOW),
  ]) {
    assert.ok(forced?.notice.startsWith(FORCED_PAUSE_NOTICE_PREFIX));
    assert.match(forced!.notice, /hours/);
  }
});

test("a box whose agent hasn't answered for hours is paused, logged with its workspace, and its session told why", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [interval("i-a", "sb-a", 2, { startedMinutesAgo: 5 * 60, agentSeenMinutesAgo: 3 * 60 })],
  });
  const report = await reconcile(deps);
  assert.deepEqual(logs.writes(), ["pause sb-a", `close i-a at ${NOW.toISOString()}`, "stopped a"]);
  assert.deepEqual(report, { skipped: false, seen: 1, paused: 1, forced: 1, lost: 0, closed: 0, failed: 0, deferred: 0 });
  assert.equal(logs.notices.length, 1);
  assert.match(logs.notices[0], /^w-a: Its box was paused: its agent hadn't answered for 3 hours/);
  assert.equal(logs.reasons[0], logs.notices[0].slice("w-a: ".length));
  assert.ok(logs.logged.some((line) => /forced pause \(unreachable\) of workspace w-a, computer a \(box sb-a/.test(line)));
  // Not heartbeated: Daytona may stop it too.
  assert.deepEqual(logs.alive, []);
});

test("a box in use past 12 hours runs on; past the 16-hour hard cap it's paused mid-turn", async () => {
  const at = (hours: number) =>
    world({
      computers: [computer("a")],
      states: { a: active },
      open: [interval("i-a", "sb-a", 2, { startedMinutesAgo: hours * 60, agentSeenMinutesAgo: 2 })],
    });
  const inUse = at(12);
  assert.equal((await reconcile(inUse.deps)).forced, 0);
  const hard = at(16);
  assert.equal((await reconcile(hard.deps)).forced, 1);
  assert.match(hard.log.notices[0], /after 16 hours running/);
  assert.ok(hard.log.logged.some((line) => line.includes("forced pause (max-run) of workspace w-a")));
});

test("a quiet box past 12 hours is paused", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: { lastActivity: ago(30 * MIN), turnTrackingVersion: 1, turnInProgress: true } } },
    open: [interval("i-a", "sb-a", 2, { startedMinutesAgo: 12 * 60, agentSeenMinutesAgo: 2 })],
  });
  assert.equal((await reconcile(deps)).forced, 1);
  assert.match(logs.notices[0], /after 12 hours running/);
});

test("an agent from before /activity is reachable: recorded as answering, and not paused as unreachable", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null, reachable: true } },
    open: [interval("i-a", "sb-a", 2, { startedMinutesAgo: 5 * 60, agentSeenMinutesAgo: null })],
  });
  const report = await reconcile(deps);
  assert.equal(report.forced, 0);
  assert.deepEqual(logs.answered, ["i-a"]);
});

test("an agent that answers again just before its forced pause keeps its box", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: [{ running: true, activity: null }, active] },
    open: [interval("i-a", "sb-a", 2, { startedMinutesAgo: 5 * 60, agentSeenMinutesAgo: null })],
  });
  const report = await reconcile(deps);
  assert.equal(report.forced, 0);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
});

test("where paused boxes can't come back (jcode), no box is forced either", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a")],
    states: { a: { running: true, activity: null } },
    open: [interval("i-a", "sb-a", 2, { startedMinutesAgo: 13 * 60, agentSeenMinutesAgo: null })],
    pauses: false,
  });
  assert.equal((await reconcile(deps)).forced, 0);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
});

test("a box kept running is heartbeated to the provider, its agent's answer recorded, and its session's pause notice cleared", async () => {
  const { deps, log: logs } = world({
    computers: [computer("a"), computer("b"), computer("c")],
    states: { a: active, b: { running: true, activity: null }, c: idle },
    open: [interval("i-a", "sb-a"), interval("i-b", "sb-b"), interval("i-c", "sb-c")],
  });
  await reconcile(deps);
  assert.deepEqual(logs.alive.sort(), ["sb-a", "sb-b"]);
  // Only the agent that answered.
  assert.deepEqual(logs.answered, ["i-a"]);
  // The idle one was paused: its box isn't running again.
  assert.deepEqual(logs.cleared.sort(), ["w-a", "w-b"]);
});

test("a heartbeat that fails doesn't fail the box", async () => {
  const { deps, log: logs } = world({ computers: [computer("a")], states: { a: active }, open: [interval("i-a", "sb-a")] });
  deps.keepAlive = async () => {
    throw new Error("daytona down");
  };
  const report = await reconcile(deps);
  assert.equal(report.failed, 0);
  assert.deepEqual(logs.writes(), ["seen i-a"]);
});

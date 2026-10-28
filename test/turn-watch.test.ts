import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONFIRM_MS,
  NEVER_STARTED_MS,
  observeTurn,
  type TurnObservation,
  UNREACHABLE_MS,
  watchUntil,
  type WatchState,
} from "@/lib/session/turn-watch";

const T0 = Date.parse("2026-11-02T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function watch(patch: Partial<WatchState> = {}): WatchState {
  return {
    sentAt: T0,
    baselineActivity: T0 - 60_000,
    seenWorking: false,
    quietSince: null,
    quietActivity: null,
    lastMessage: null,
    unreachableSince: null,
    ...patch,
  };
}

function look(now: number, patch: Partial<TurnObservation> = {}, summary: Partial<NonNullable<TurnObservation["summary"]>> = {}): TurnObservation {
  return {
    now,
    status: "ready",
    reachable: true,
    working: false,
    summary: { lastAssistantMessage: "Opened #12.", lastActivity: iso(now - 30_000), state: "running", ...summary },
    ...patch,
  };
}

/** Look until it's no longer waiting, carrying the state, as the watch does. */
function run(start: WatchState, looks: TurnObservation[]) {
  let state = start;
  const verdicts = [];
  for (const l of looks) {
    const v = observeTurn(state, l);
    verdicts.push(v.kind);
    if (v.kind !== "waiting") return { verdicts, last: v };
    state = v.state;
  }
  return { verdicts, last: null };
}

test("an end is seen twice, apart, before it counts", () => {
  const activity = iso(T0 + 5_000);
  const { verdicts, last } = run(watch(), [
    look(T0 + 60_000, {}, { lastActivity: activity }),
    look(T0 + 60_000 + CONFIRM_MS - 1, {}, { lastActivity: activity }),
    look(T0 + 60_000 + CONFIRM_MS, {}, { lastActivity: activity }),
  ]);
  assert.deepEqual(verdicts, ["waiting", "waiting", "over"]);
  assert.deepEqual(last, { kind: "over", message: "Opened #12.", asleep: false });
});

test("a pause between tool calls isn't an end: activity moved between the looks", () => {
  const { verdicts } = run(watch(), [
    look(T0 + 60_000, {}, { lastActivity: iso(T0 + 5_000) }),
    look(T0 + 80_000, {}, { lastActivity: iso(T0 + 70_000) }),
    look(T0 + 90_000, {}, { lastActivity: iso(T0 + 70_000) }),
  ]);
  assert.deepEqual(verdicts, ["waiting", "waiting", "waiting"]);
});

test("a subagent at work keeps the turn open, however quiet the main log", () => {
  const { verdicts } = run(
    watch(),
    Array.from({ length: 10 }, (_, i) => look(T0 + 60_000 + i * 20_000, { working: true }, { lastActivity: iso(T0 + 1_000) })),
  );
  assert.ok(verdicts.every((v) => v === "waiting"));
});

test("mid-turn, then done: ends once the second look agrees", () => {
  const done = iso(T0 + 100_000);
  const { verdicts } = run(watch(), [
    look(T0 + 30_000, { working: true }),
    look(T0 + 130_000, {}, { lastActivity: done }),
    look(T0 + 150_000, {}, { lastActivity: done }),
  ]);
  assert.deepEqual(verdicts, ["waiting", "waiting", "over"]);
});

test("the box's clock and ours needn't agree", () => {
  // The box runs an hour ahead: its stamps are "in the future" to us.
  const ahead = (ms: number) => iso(ms + 3_600_000);
  const state = watch({ baselineActivity: T0 - 60_000 + 3_600_000 });
  const { verdicts } = run(state, [
    look(T0 + 30_000, { working: true }, { lastActivity: ahead(T0 + 20_000) }),
    look(T0 + 60_000, {}, { lastActivity: ahead(T0 + 50_000) }),
    look(T0 + 80_000, {}, { lastActivity: ahead(T0 + 50_000) }),
  ]);
  assert.deepEqual(verdicts, ["waiting", "waiting", "over"]);
});

test("an old reply left from the last turn isn't this turn's end", () => {
  // Nothing has happened on the box since the send.
  const { verdicts } = run(watch(), [
    look(T0 + 30_000, {}, { lastActivity: iso(T0 - 60_000), lastAssistantMessage: "the old reply" }),
    look(T0 + 50_000, {}, { lastActivity: iso(T0 - 60_000), lastAssistantMessage: "the old reply" }),
  ]);
  assert.deepEqual(verdicts, ["waiting", "waiting"]);
});

test("a box that slept, or was paused, ended its turn: the last reply read is the one", () => {
  const v = observeTurn(watch({ lastMessage: "Pushed the fix." }), look(T0 + 600_000, { status: "suspended", reachable: false, summary: null }));
  assert.deepEqual(v, { kind: "over", message: "Pushed the fix.", asleep: true });
});

test("a box resuming or a session setting up is waited for", () => {
  for (const status of ["resuming", "provisioning", "creating", "restoring"] as const) {
    assert.equal(observeTurn(watch(), look(T0, { status, reachable: false, summary: null })).kind, "waiting", status);
  }
});

test("what can't end is lost, with its cause", () => {
  assert.deepEqual(observeTurn(watch(), look(T0, { status: "failed", errorMessage: "the plan's box limit" })), {
    kind: "lost",
    cause: "its session failed: the plan's box limit",
  });
  assert.deepEqual(observeTurn(watch(), look(T0, {}, { state: "exited" })), { kind: "lost", cause: "its agent exited" });
  // Not answering: waited for a while first.
  const gone = observeTurn(watch(), look(T0, { reachable: false, summary: null }));
  assert.equal(gone.kind, "waiting");
  const since = gone.kind === "waiting" ? gone.state : watch();
  assert.equal(observeTurn(since, look(T0 + UNREACHABLE_MS - 1, { reachable: false, summary: null })).kind, "waiting");
  assert.deepEqual(observeTurn(since, look(T0 + UNREACHABLE_MS, { reachable: false, summary: null })), {
    kind: "lost",
    cause: "its box stopped answering",
  });
  // Answering again clears it.
  const back = observeTurn(since, look(T0 + 60_000, { working: true }));
  assert.equal(back.kind === "waiting" && back.state.unreachableSince, null);
  assert.deepEqual(observeTurn(watch(), look(T0 + NEVER_STARTED_MS, {}, { lastActivity: iso(T0 - 90_000) })), {
    kind: "lost",
    cause: "it never started on its message",
  });
});

test("archived or deleted on purpose: nothing to report", () => {
  for (const status of ["archived", "archiving", "destroyed", "destroying"] as const) {
    assert.deepEqual(observeTurn(watch(), look(T0, { status })), { kind: "closed" }, status);
  }
});

test("a box too old to say whether it's mid-turn is judged by going quiet", () => {
  const activity = iso(T0 + 5_000);
  const { verdicts } = run(watch(), [
    look(T0 + 15_000, { working: null }, { lastActivity: activity }),
    look(T0 + 40_000, { working: null }, { lastActivity: activity }),
    look(T0 + 60_000, { working: null }, { lastActivity: activity }),
  ]);
  assert.deepEqual(verdicts, ["waiting", "waiting", "over"]);
});

test("watchUntil looks until done, or until its time is up", async () => {
  let clock = 0;
  const opts = { forMs: 100, everyMs: 10, sleep: async (ms: number) => void (clock += ms), now: () => clock };
  let n = 0;
  assert.equal(await watchUntil(async () => ++n === 3, opts), true);
  assert.equal(n, 3);
  clock = 0;
  assert.equal(await watchUntil(async () => false, opts), false);
  assert.equal(clock, 100);
});

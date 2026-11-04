import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachFailurePlan,
  dropNarration,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  rearmedSince,
  reconnectPlan,
  WS_OPEN,
  type WsAction,
  wsReducer,
} from "@/lib/runtime/reconnect";

test("a re-armed retry run starts its clock fresh only after a give-up", () => {
  // Re-armed after a give-up: the clock times this run, not the drop it
  // recovered from.
  assert.equal(rearmedSince({ gaveUp: true, since: 1_000 }, 5_000), 5_000);
  // Re-armed while the automatic loop is still running: the same outage, so
  // the clock it has keeps counting rather than going back to zero.
  assert.equal(rearmedSince({ gaveUp: false, since: 1_000 }, 5_000), 1_000);
  // Nothing dropped yet: nothing to time.
  assert.equal(rearmedSince({ gaveUp: false, since: null }, 5_000), null);
});

test("reconnectPlan backs off exponentially from the base delay", () => {
  assert.deepEqual(reconnectPlan(1), { retry: true, delayMs: RECONNECT_BASE_MS });
  assert.deepEqual(reconnectPlan(2), { retry: true, delayMs: RECONNECT_BASE_MS * 2 });
  assert.deepEqual(reconnectPlan(3), { retry: true, delayMs: RECONNECT_BASE_MS * 4 });
  assert.deepEqual(reconnectPlan(4), { retry: true, delayMs: RECONNECT_BASE_MS * 8 });
});

test("reconnectPlan pins late in-budget attempts to the delay ceiling", () => {
  // The raw exponential delay for the last in-budget attempt exceeds the cap,
  // so it must clamp to exactly RECONNECT_MAX_MS (the capping path is real).
  const raw = RECONNECT_BASE_MS * 2 ** (MAX_RECONNECT_ATTEMPTS - 1);
  assert.ok(raw > RECONNECT_MAX_MS, "cap is only meaningful if the raw delay exceeds it");
  assert.deepEqual(reconnectPlan(MAX_RECONNECT_ATTEMPTS), {
    retry: true,
    delayMs: RECONNECT_MAX_MS,
  });
});

test("reconnectPlan retries through the whole budget then gives up", () => {
  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
    assert.equal(reconnectPlan(attempt).retry, true, `attempt ${attempt} should retry`);
  }
  assert.deepEqual(reconnectPlan(MAX_RECONNECT_ATTEMPTS + 1), { retry: false });
  assert.deepEqual(reconnectPlan(MAX_RECONNECT_ATTEMPTS + 5), { retry: false });
});

test("a dropped stream narrates its automatic retries", () => {
  const auto = dropNarration({ dropped: true, gaveUp: false, manual: false, attempt: 2, since: 1000 });
  assert.deepEqual(auto.reconnecting, { attempt: 2, max: MAX_RECONNECT_ATTEMPTS, since: 1000 });
  assert.equal(auto.lost, false);
});

test("a dropped stream whose retries are exhausted is lost", () => {
  const gone = dropNarration({ dropped: true, gaveUp: true, manual: false, attempt: 7, since: 1000 });
  assert.equal(gone.reconnecting, null);
  assert.equal(gone.lost, true);
});

test("a retry the user asked for doesn't blink to Reconnecting", () => {
  const manual = dropNarration({ dropped: true, gaveUp: true, manual: true, attempt: 0, since: 1000 });
  assert.equal(manual.reconnecting, null, "the automatic narration stays quiet");
  assert.equal(manual.lost, true, "the lost connection notice stays, its button spinning");
});

test("a close while a manual retry is under way hands the story back to the automatic one", () => {
  // The hook clears `manual` on a fresh close; what is left narrates itself.
  const back = dropNarration({ dropped: true, gaveUp: false, manual: false, attempt: 1, since: 2000 });
  assert.deepEqual(back.reconnecting, { attempt: 1, max: MAX_RECONNECT_ATTEMPTS, since: 2000 });
  assert.equal(back.lost, false);
});

test("nothing is narrated while the attachment itself has the answer", () => {
  const quiet = dropNarration({ dropped: false, gaveUp: true, manual: true, attempt: 0, since: null });
  assert.deepEqual(quiet, { reconnecting: null, lost: false });
});

test("a reconnected socket ends the drop as it opens, before any frame", () => {
  const run = (...actions: WsAction[]) => actions.reduce(wsReducer, { ...WS_OPEN, live: true });
  // Dropped mid-tool-call, then back: the resumed stream is quiet until
  // Claude next writes, which mustn't read as still reconnecting.
  const back = run({ kind: "closed", attempt: 1, at: 1_000 }, { kind: "opening" }, { kind: "opened" });
  assert.deepEqual(back, { ...WS_OPEN, live: true });
  assert.deepEqual(dropNarration({ dropped: back.closed, gaveUp: back.gaveUp, manual: false, attempt: back.attempt, since: back.since }), {
    reconnecting: null,
    lost: false,
  });
  // Opened only: still reconnecting, counting the run's time.
  const reopening = run({ kind: "closed", attempt: 1, at: 1_000 }, { kind: "opening" });
  assert.equal(reopening.closed, true);
  assert.equal(reopening.since, 1_000);
  // Back after giving up: the lost-connection error goes too, but a frame
  // that couldn't be read stays reported.
  const recovered = run(
    { kind: "protocol-error", ref: "R1" },
    { kind: "closed", attempt: 7, at: 1_000 },
    { kind: "gave-up" },
    { kind: "error", message: "Lost connection to this session." },
    { kind: "opened" },
  );
  assert.deepEqual(recovered, { ...WS_OPEN, live: true, protocolErrorRef: "R1" });
});

test("a failed refetch during a reconnect carries the loop on, on the same budget", () => {
  // A 502 or a box still settling: the next attempt comes from the budget.
  assert.deepEqual(attachFailurePlan(2, null), reconnectPlan(2));
  assert.deepEqual(attachFailurePlan(3, "box-restore-failed"), reconnectPlan(3));
  // The budget still ends it.
  assert.deepEqual(attachFailurePlan(MAX_RECONNECT_ATTEMPTS + 1, null), { retry: false });
  // A box that's gone, or an agent that didn't start: retrying can't help.
  assert.deepEqual(attachFailurePlan(2, "box-gone"), { retry: false });
  assert.deepEqual(attachFailurePlan(2, "session-not-started"), { retry: false });
  // A session archived from another tab: a stale tab stops at once.
  assert.deepEqual(attachFailurePlan(2, "session-ended"), { retry: false });
});

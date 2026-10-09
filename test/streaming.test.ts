import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isLive,
  LIVE_WINDOW_MS,
  REVEAL_CATCH_UP_MS,
  REVEAL_CHARS_PER_SECOND,
  revealedText,
  revealRate,
  revealStep,
} from "@/lib/session/streaming";

/** Reveal `target` characters from `from`, ticking every `tick` ms at the pace
 *  set when they arrived; how long it took. */
function timeToReveal(from: number, target: number, tick = 40): { ms: number; shown: number } {
  const rate = revealRate(from, target);
  let shown = from;
  let ms = 0;
  while (shown < target && ms < 60_000) {
    shown = revealStep(shown, target, tick, rate);
    ms += tick;
  }
  return { ms, shown };
}

test("a small arrival reveals at the resting pace, by time", () => {
  const rate = revealRate(0, 50);
  assert.equal(rate, REVEAL_CHARS_PER_SECOND / 1000);
  assert.equal(revealStep(0, 50, 100, rate), Math.ceil(rate * 100));
  // Twice the time, twice the text: the pace is per millisecond, not per frame.
  assert.equal(revealStep(0, 50, 200, rate), Math.ceil(rate * 200));
});

// The reveal moves on ticks, so "within the window" is up to the first tick at
// or after it.
const TICK = 40;
const DEADLINE = Math.ceil(REVEAL_CATCH_UP_MS / TICK) * TICK;

test("a large arrival is shown in full within the catch-up window", () => {
  for (const target of [500, 5000, 50_000]) {
    const { ms, shown } = timeToReveal(0, target, TICK);
    assert.equal(shown, target);
    assert.ok(ms <= DEADLINE, `${target} chars took ${ms}ms`);
  }
});

test("text arriving mid-reveal is paced from what is still hidden", () => {
  const { ms, shown } = timeToReveal(4000, 9000, TICK);
  assert.equal(shown, 9000);
  assert.ok(ms <= DEADLINE, `took ${ms}ms`);
});

test("the reveal always moves, and never past the text", () => {
  const rate = revealRate(0, 100);
  assert.equal(revealStep(10, 11, 0, rate), 11);
  assert.equal(revealStep(10, 10, 500, rate), 10);
  assert.equal(revealStep(12, 10, 500, rate), 10);
  assert.equal(revealStep(0, 3, -50, rate), 1);
});

test("the shown text stops at the end of a word", () => {
  const text = "Pulled the latest main";
  assert.equal(revealedText(text, 9), "Pulled");
  assert.equal(revealedText(text, 10), "Pulled the");
  assert.equal(revealedText(text, 11), "Pulled the ");
  assert.equal(revealedText(text, 100), text);
  assert.equal(revealedText(text, 0), "");
});

test("a first word longer than the count is shown as far as it goes", () => {
  assert.equal(revealedText("Supercalifragilistic word", 5), "Super");
});

test("messages from moments ago are live; older ones and bad stamps are history", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(isLive("2026-10-09T11:59:58Z", now), true);
  assert.equal(isLive(new Date(now - LIVE_WINDOW_MS - 1).toISOString(), now), false);
  assert.equal(isLive("not a time", now), false);
});

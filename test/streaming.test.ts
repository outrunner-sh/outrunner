import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isLive,
  LIVE_WINDOW_MS,
  REVEAL_CATCH_UP_MS,
  REVEAL_CHARS_PER_SECOND,
  revealedText,
  revealStep,
} from "@/lib/session/streaming";

test("a small arrival reveals at the resting pace, by time", () => {
  assert.equal(revealStep(0, 50, 100), Math.floor((REVEAL_CHARS_PER_SECOND / 1000) * 100));
  // Twice the time, twice the text: the rate is per millisecond, not per frame.
  assert.equal(revealStep(0, 50, 200), Math.floor((REVEAL_CHARS_PER_SECOND / 1000) * 200));
});

test("a large arrival is cleared within the catch-up window", () => {
  let shown = 0;
  const target = 5000;
  for (let t = 0; t < REVEAL_CATCH_UP_MS; t += 40) shown = revealStep(shown, target, 40);
  assert.ok(shown >= target * 0.6, `showed ${shown}`);
  // And it does finish, never overshooting.
  for (let i = 0; i < 100; i++) shown = revealStep(shown, target, 40);
  assert.equal(shown, target);
});

test("the reveal always moves, and never past the text", () => {
  assert.equal(revealStep(10, 11, 0), 11);
  assert.equal(revealStep(10, 10, 500), 10);
  assert.equal(revealStep(12, 10, 500), 10);
  assert.equal(revealStep(0, 3, -50), 1);
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

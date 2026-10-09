import assert from "node:assert/strict";
import { test } from "node:test";

import { SKELETON_DELAY_MS, SKELETON_MIN_VISIBLE_MS, skeletonDecision } from "@/lib/session/skeleton-swap";

test("a load is given a moment before any skeleton shows", () => {
  assert.deepEqual(skeletonDecision({ ready: false, loadingSince: 0, shownAt: null, now: 50 }), {
    show: false,
    recheckIn: SKELETON_DELAY_MS - 50,
  });
});

test("a load that outlasts the moment shows the skeleton", () => {
  assert.deepEqual(skeletonDecision({ ready: false, loadingSince: 0, shownAt: null, now: SKELETON_DELAY_MS }), {
    show: true,
    recheckIn: null,
  });
});

test("a load that finishes within the moment never shows one", () => {
  assert.deepEqual(skeletonDecision({ ready: true, loadingSince: 0, shownAt: null, now: 80 }), {
    show: false,
    recheckIn: null,
  });
});

test("a shown skeleton stays while loading", () => {
  assert.deepEqual(skeletonDecision({ ready: false, loadingSince: 0, shownAt: 120, now: 5000 }), {
    show: true,
    recheckIn: null,
  });
});

test("a shown skeleton is held its minimum even when the data lands at once", () => {
  assert.deepEqual(skeletonDecision({ ready: true, loadingSince: 0, shownAt: 120, now: 200 }), {
    show: true,
    recheckIn: SKELETON_MIN_VISIBLE_MS - 80,
  });
});

test("after its minimum, a skeleton gives way to the data", () => {
  assert.deepEqual(
    skeletonDecision({ ready: true, loadingSince: 0, shownAt: 120, now: 120 + SKELETON_MIN_VISIBLE_MS }),
    { show: false, recheckIn: null },
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { STALE_PROVISION_MS } from "@/lib/billing/limits";
import {
  abandonedBoxClaim,
  BOX_CLAIM_ABANDONED_AFTER_MS,
  BOX_CLAIM_ABANDONED_MESSAGE,
  canDestroy,
  INTERRUPTED_TRANSITIONS,
  interruptedSetups,
  SETUP_INTERRUPTED_AFTER_MS,
  SETUP_INTERRUPTED_MESSAGE,
  SETUP_STALLS_AFTER_MS,
  setupState,
  TRANSITION_INTERRUPTED_AFTER_MS,
  transitionsInterruptedBefore,
} from "@/lib/session/provisioning";

const createdAt = "2026-10-01T00:00:00Z";
const made = Date.parse(createdAt);

test("a session setting up runs until it has taken too long, then counts as stalled", () => {
  for (const status of ["creating", "provisioning"] as const) {
    assert.equal(setupState({ status, createdAt }, made), "running");
    assert.equal(setupState({ status, createdAt }, made + SETUP_STALLS_AFTER_MS - 1), "running");
    assert.equal(setupState({ status, createdAt }, made + SETUP_STALLS_AFTER_MS), "stalled");
  }
});

test("a session past setup has ended, however old", () => {
  for (const status of ["ready", "failed", "destroyed", "resuming"] as const) {
    assert.equal(setupState({ status, createdAt }, made + 365 * 86_400_000), "ended");
  }
});

test("a setup whose start can't be read is stalled rather than spinning for good", () => {
  assert.equal(setupState({ status: "creating", createdAt: "not a date" }, made), "stalled");
});

test("a session setting up can be deleted only once its setup has stalled", () => {
  assert.equal(canDestroy({ status: "creating", createdAt }, made + 60_000), false);
  assert.equal(canDestroy({ status: "creating", createdAt }, made + SETUP_STALLS_AFTER_MS), true);
  // Other changes under way are never deletable, however long they take.
  assert.equal(canDestroy({ status: "destroying", createdAt }, made + SETUP_STALLS_AFTER_MS), false);
  assert.equal(canDestroy({ status: "ready", createdAt }, made), true);
});

test("a setup is taken as cut off only once its row has gone unchanged for the bound", () => {
  const now = new Date(made + 60 * 60_000);
  const { from, unchangedSince } = interruptedSetups(now);
  // Only sessions setting up: one ready, failed or deleted is never touched.
  assert.deepEqual(from, ["creating", "provisioning"]);
  assert.equal(Date.parse(unchangedSince), now.getTime() - SETUP_INTERRUPTED_AFTER_MS);
});

test("the page offers to keep waiting before a setup is failed as cut off", () => {
  assert.ok(SETUP_INTERRUPTED_AFTER_MS > SETUP_STALLS_AFTER_MS);
});

test("a setup cut off fails with why, and what to do", () => {
  const { patch } = interruptedSetups(new Date(made));
  assert.equal(patch.status, "failed");
  assert.equal(patch.errorMessage, SETUP_INTERRUPTED_MESSAGE);
  assert.match(patch.errorMessage, /stopped before it finished/);
  assert.match(patch.errorMessage, /restarted/);
  assert.match(patch.errorMessage, /Try again/);
});

test("each lifecycle step a restart can cut off goes back where it can be tried again", () => {
  const ends = new Map(INTERRUPTED_TRANSITIONS.map((t) => [t.from, t.to]));
  // Every status only a lifecycle request moves on, and nothing else.
  assert.deepEqual([...ends.keys()].sort(), ["archiving", "destroying", "restoring", "resuming", "suspending"]);
  assert.equal(ends.get("archiving"), "ready");
  assert.equal(ends.get("restoring"), "archived");
  assert.equal(ends.get("resuming"), "suspended");
  assert.equal(ends.get("suspending"), "suspended");
  // A delete cut off can be deleted again; before, it could never be.
  assert.equal(canDestroy({ status: "destroying", createdAt: new Date(0).toISOString() }, Date.now()), false);
  assert.equal(canDestroy({ status: ends.get("destroying")!, createdAt: new Date(0).toISOString() }, Date.now()), true);
  for (const { message } of INTERRUPTED_TRANSITIONS) assert.match(message, /restarted/);
});

test("a lifecycle step is taken as cut off only well past the longest one", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  assert.equal(transitionsInterruptedBefore(now), "2026-10-28T11:30:00.000Z");
  assert.ok(TRANSITION_INTERRUPTED_AFTER_MS > SETUP_INTERRUPTED_AFTER_MS);
});

test("a box claim cut off is left as its provision's own failure would leave it", () => {
  assert.deepEqual(abandonedBoxClaim("box-1"), { status: "stopped", errorMessage: BOX_CLAIM_ABANDONED_MESSAGE });
  assert.deepEqual(abandonedBoxClaim(null), { status: "error", errorMessage: BOX_CLAIM_ABANDONED_MESSAGE });
  // Not before the plan stops counting it, nor the longest real provision.
  assert.ok(BOX_CLAIM_ABANDONED_AFTER_MS >= STALE_PROVISION_MS);
  assert.ok(BOX_CLAIM_ABANDONED_AFTER_MS > 13 * 60_000);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canDestroy,
  interruptedSetups,
  SETUP_INTERRUPTED_AFTER_MS,
  SETUP_INTERRUPTED_MESSAGE,
  SETUP_STALLS_AFTER_MS,
  setupState,
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

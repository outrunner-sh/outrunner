import assert from "node:assert/strict";
import { test } from "node:test";

import { canDestroy, SETUP_STALLS_AFTER_MS, setupState } from "@/lib/session/provisioning";

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

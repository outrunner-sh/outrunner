import assert from "node:assert/strict";
import { test } from "node:test";

import { wakeFor } from "@/lib/api/wake";

test("a session that finished a while ago, its box paused while idle, is opened before a message reaches it", () => {
  // As on 2026-11-21: the session ready, its computer "stopped" by the
  // reconciler ("Paused while idle; it resumes with the next session."), and
  // every follow-up refused with "Runtime Computer is not ready." (409).
  assert.equal(wakeFor("ready", "stopped"), "open");
  assert.equal(wakeFor("idle", "stopped"), "open");
  // Lost, or still coming back for another request: the session route sorts
  // it out (bringBack waits on one being brought back), as it does for the page.
  assert.equal(wakeFor("ready", "error"), "open");
  assert.equal(wakeFor("ready", "provisioning"), "open");
});

test("a paused or archived session is resumed or restored, as before", () => {
  assert.equal(wakeFor("suspended", "stopped"), "resume");
  assert.equal(wakeFor("suspended", null), "resume");
  assert.equal(wakeFor("archived", null), "restore");
});

test("a session whose box is up, or that has none, or is on its way somewhere, is left alone", () => {
  assert.equal(wakeFor("ready", "ready"), null);
  assert.equal(wakeFor("idle", "ready"), null);
  // No computer at all: nothing to bring back, and the send says why.
  assert.equal(wakeFor("ready", null), null);
  for (const status of ["creating", "provisioning", "suspending", "resuming", "archiving", "restoring", "failed", "destroying", "destroyed"] as const) {
    assert.equal(wakeFor(status, "stopped"), null, status);
  }
});

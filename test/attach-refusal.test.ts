import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionGoneMessage } from "@/lib/session/attach-refusal";

test("an archived or deleted session is never attached to, so its box isn't started again", () => {
  for (const status of ["archiving", "archived", "destroying", "destroyed"] as const) {
    assert.ok(sessionGoneMessage(status), status);
  }
  assert.match(sessionGoneMessage("archived")!, /Restore/);
});

test("a live, paused, failed or still-starting session attaches as before", () => {
  // Suspended attaches before it resumes (lib/session/wake-session.ts).
  for (const status of ["creating", "provisioning", "ready", "idle", "suspending", "resuming", "suspended", "restoring", "failed"] as const) {
    assert.equal(sessionGoneMessage(status), null, status);
  }
});

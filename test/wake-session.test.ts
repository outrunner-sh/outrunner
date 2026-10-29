import assert from "node:assert/strict";
import { test } from "node:test";

import { wakeSteps } from "@/lib/session/wake-session";

test("a session left ready while its box was paused idle is brought back before a prompt", () => {
  // The reconciler pauses an idle box and marks it stopped; the session stays
  // ready. The message route only sends to a box that's up.
  assert.deepEqual(wakeSteps("ready", "stopped"), ["attach"]);
  assert.deepEqual(wakeSteps("idle", "stopped"), ["attach"]);
  assert.deepEqual(wakeSteps("ready", "error"), ["attach"]);
  assert.deepEqual(wakeSteps("ready", null), ["attach"]);
  assert.deepEqual(wakeSteps("idle", "ready"), ["attach"]);
  // A ready row does not prove the workspace's tmux session still exists.
  assert.deepEqual(wakeSteps("ready", "ready"), ["attach"]);
});

test("a suspended session's box is up before it's resumed, and an archived one restores its own", () => {
  // Resume asks the agent on the box, which a paused box hasn't.
  assert.deepEqual(wakeSteps("suspended", "stopped"), ["attach", "resume"]);
  assert.deepEqual(wakeSteps("suspended", "ready"), ["resume"]);
  assert.deepEqual(wakeSteps("archived", "stopped"), ["restore"]);
  assert.deepEqual(wakeSteps("archived", null), ["restore"]);
});

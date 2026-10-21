import assert from "node:assert/strict";
import { test } from "node:test";

import { startingCloudModel } from "@/lib/onboarding/claude-choice";

test("a session starts on Outrunner's models wherever the server has them, Claude or not", () => {
  for (const connected of [true, false, null]) {
    assert.equal(startingCloudModel({ connected, outrunnerModels: true }), "outrunner", `connected=${connected}`);
  }
});

test("without Outrunner's models only a saved Claude connection starts a session", () => {
  assert.equal(startingCloudModel({ connected: true, outrunnerModels: false }), "claude");
  // Nothing to start on: the user finishes and connects in Settings.
  assert.equal(startingCloudModel({ connected: false, outrunnerModels: false }), null);
  // Still checking: Start waits.
  assert.equal(startingCloudModel({ connected: null, outrunnerModels: false }), null);
});

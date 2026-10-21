import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeOffer, startingCloudModel } from "@/lib/onboarding/claude-choice";

test("Connect Claude shows only to a user who has Claude, where Outrunner's models run", () => {
  const cases = [
    // [connected, onMac, offer]
    [true, false, "optional"],
    [false, true, "optional"],
    [true, true, "optional"],
    [false, false, "hidden"],
    // Still checking: nothing to show yet.
    [null, null, "hidden"],
    [null, true, "optional"],
  ] as const;
  for (const [connected, onMac, offer] of cases) {
    assert.equal(claudeOffer({ connected, onMac, outrunnerModels: true }), offer, `${connected}/${onMac}`);
  }
});

test("without Outrunner's models Claude is a must, whatever was found", () => {
  for (const connected of [true, false, null]) {
    for (const onMac of [true, false, null]) {
      assert.equal(claudeOffer({ connected, onMac, outrunnerModels: false }), "required");
    }
  }
});

test("a session starts on Outrunner's models unless Claude is already connected", () => {
  assert.equal(startingCloudModel({ connected: false, outrunnerModels: true }), "outrunner");
  assert.equal(startingCloudModel({ connected: true, outrunnerModels: true }), "claude");
  assert.equal(startingCloudModel({ connected: true, outrunnerModels: false }), "claude");
  // Nothing to start on until Claude is connected.
  assert.equal(startingCloudModel({ connected: false, outrunnerModels: false }), null);
  // Still checking: Start waits rather than go out on Outrunner's a moment early.
  assert.equal(startingCloudModel({ connected: null, outrunnerModels: true }), null);
});

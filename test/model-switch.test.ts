import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError } from "@/lib/runtime/agent-client";
import { switchFailure } from "@/lib/runtime/model-switch";

test("a refusal from the agent passes its own advice through", () => {
  const busy = new AgentRequestError(409, {
    code: "CONFLICT",
    message: "Claude is mid-turn; switch models once it has finished",
  });
  assert.deepEqual(switchFailure(busy), { status: 409, message: "Claude is mid-turn; switch models once it has finished" });
});

test("a missing model route means the box's agent predates switching", () => {
  const { status, message } = switchFailure(new AgentRequestError(404));
  assert.equal(status, 409);
  assert.match(message, /older Outrunner that can't switch models/);
});

test("an unknown session is a failure, not an outdated agent", () => {
  const gone = new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" });
  assert.equal(switchFailure(gone).status, 502);
});

test("anything else asks to try again, without the raw error", () => {
  for (const error of [new AgentRequestError(500, { code: "INTERNAL", message: "tmux: exit 1" }), new Error("fetch failed"), "x"]) {
    assert.deepEqual(switchFailure(error), { status: 502, message: "Couldn't switch models. Please try again." });
  }
});

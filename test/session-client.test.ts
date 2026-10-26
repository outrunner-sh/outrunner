import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamProtocolError } from "../lib/runtime/session-client.ts";

test("a protocol error carries a short reference to quote", () => {
  const error = new StreamProtocolError("Events frame did not match AgentEvent schema");
  assert.match(error.ref, /^[0-9a-f]{8}$/);
  assert.equal(error.message, "Events frame did not match AgentEvent schema");
  assert.ok(error instanceof Error);
});

test("each protocol error gets its own reference", () => {
  const refs = new Set(Array.from({ length: 20 }, () => new StreamProtocolError("x").ref));
  assert.equal(refs.size, 20);
});

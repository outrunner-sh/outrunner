import assert from "node:assert/strict";
import test from "node:test";

import { boxHostsSession } from "@/lib/runtime/box-session";

const box = { id: "computer-1", workspaceId: "session-1" };

test("a box hosts the session it was made for", () => {
  assert.equal(boxHostsSession(box, { id: "session-1", computerId: null }), true);
});

test("a project's shared box hosts the sessions that record it", () => {
  const shared = { id: "computer-1", workspaceId: null };
  assert.equal(boxHostsSession(shared, { id: "session-2", computerId: "computer-1" }), true);
});

test("a box speaks for no other session of its user's", () => {
  // Another session of the same user, on its own box: a box's secret, read
  // by its session's code, must not act for it.
  assert.equal(boxHostsSession(box, { id: "session-2", computerId: "computer-2" }), false);
  assert.equal(boxHostsSession(box, { id: "session-2", computerId: null }), false);
  assert.equal(boxHostsSession({ id: "computer-1", workspaceId: null }, { id: "session-2", computerId: null }), false);
});

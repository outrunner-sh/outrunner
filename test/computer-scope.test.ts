import assert from "node:assert/strict";
import { test } from "node:test";

import { inScope, ownBox, scopeOf } from "@/lib/runtime/computer-scope";

const shared = { projectId: "p-1", workspaceId: null };
const own = { projectId: "p-1", workspaceId: "w-1" };

test("a session gets its own box, unless it is on its project's shared one", () => {
  // New: no box yet.
  assert.deepEqual(scopeOf({ id: "w-1" }, null), { workspaceId: "w-1" });
  assert.deepEqual(scopeOf({ id: "w-1" }, own), { workspaceId: "w-1" });
  // From before each had its own: it stays on the shared box.
  assert.deepEqual(scopeOf({ id: "w-2" }, shared), { projectId: "p-1" });
});

test("a box is in the scope of its own workspace, or of the project it is shared in", () => {
  assert.equal(inScope(own, { workspaceId: "w-1" }), true);
  assert.equal(inScope(own, { workspaceId: "w-2" }), false);
  assert.equal(inScope(own, { projectId: "p-1" }), false);
  assert.equal(inScope(shared, { projectId: "p-1" }), true);
  assert.equal(inScope(shared, { projectId: "p-2" }), false);
  assert.equal(inScope(shared, { workspaceId: "w-1" }), false);
  assert.equal(ownBox(own), true);
  assert.equal(ownBox(shared), false);
});

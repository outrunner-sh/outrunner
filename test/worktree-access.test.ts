import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentsUnavailable, reachableWorktree } from "@/lib/runtime/worktree-access";

const ready = { status: "ready" as const, daytonaSandboxId: "sb-1" };

test("a ready box with a worktree on record is reached", () => {
  assert.deepEqual(reachableWorktree(ready, "/home/runtime/workspaces/ws-1"), {
    ok: true,
    sandboxId: "sb-1",
    worktree: "/home/runtime/workspaces/ws-1",
  });
});

test("a paused box says so, instead of running git on it", () => {
  const reach = reachableWorktree({ ...ready, status: "stopped" }, "/w");
  assert.equal(reach.ok, false);
  assert.match(!reach.ok ? reach.error : "", /paused\. Open the session to wake it/);
});

test("a box starting or failed is not reached either", () => {
  for (const status of ["provisioning", "error"] as const) {
    const reach = reachableWorktree({ ...ready, status }, "/w");
    assert.equal(reach.ok, false, status);
    assert.match(!reach.ok ? reach.error : "", /isn't ready yet/);
  }
});

test("no box, or no worktree on record, is not available yet", () => {
  for (const reach of [
    reachableWorktree(null, "/w"),
    reachableWorktree({ ...ready, daytonaSandboxId: null }, "/w"),
    reachableWorktree(ready, ""),
    reachableWorktree(ready, null),
  ]) {
    assert.deepEqual(reach, { ok: false, error: "The interactive worktree is not available yet." });
  }
});

test("files are refused only when there is no worktree to put them in", () => {
  // They would land in /.attachments, where Claude would not look.
  assert.match(attachmentsUnavailable(1, "") ?? "", /can't be attached/);
  assert.match(attachmentsUnavailable(2, null) ?? "", /can't be attached/);
  // A message without files still goes.
  assert.equal(attachmentsUnavailable(0, ""), null);
  assert.equal(attachmentsUnavailable(1, "/home/runtime/workspaces/ws-1"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { lastBoxes, lostBoxes, mayHaveLostBox } from "@/lib/runtime/lost-box";

test("a row claimed or failed with no box may have lost one; a box deleted on purpose, or one named, is not lost", () => {
  assert.equal(mayHaveLostBox({ status: "provisioning", daytonaSandboxId: null }), true);
  assert.equal(mayHaveLostBox({ status: "error", daytonaSandboxId: null }), true);
  // Deleted with its session: stopped, naming none.
  assert.equal(mayHaveLostBox({ status: "stopped", daytonaSandboxId: null }), false);
  assert.equal(mayHaveLostBox({ status: "provisioning", daytonaSandboxId: "box-1" }), false);
  assert.equal(mayHaveLostBox({ status: "ready", daytonaSandboxId: null }), false);
});

test("each computer's newest box, by when it started", () => {
  const last = lastBoxes([
    { computerId: "c1", sandboxId: "old", startedAt: "2026-11-01T00:00:00Z" },
    { computerId: "c1", sandboxId: "new", startedAt: "2026-11-12T07:25:05Z" },
    { computerId: "c1", sandboxId: "older", startedAt: "2026-10-30T00:00:00Z" },
    { computerId: "c2", sandboxId: "other", startedAt: "2026-11-02T00:00:00Z" },
  ]);
  assert.deepEqual(Object.fromEntries(last), { c1: "new", c2: "other" });
});

test("the orphan sweep keeps a box a row lost, and only its newest", () => {
  const intervals = [
    // The prod row: claimed to bring box 6041 back, cut off by a deploy.
    { computerId: "c1", sandboxId: "box-6041", startedAt: "2026-11-12T07:25:05Z" },
    { computerId: "c1", sandboxId: "box-replaced", startedAt: "2026-10-01T00:00:00Z" },
    // A session deleted with its box: stopped, naming none.
    { computerId: "c2", sandboxId: "box-deleted", startedAt: "2026-11-11T00:00:00Z" },
    // A row that names its box: that box is the sweep's own business.
    { computerId: "c3", sandboxId: "box-named", startedAt: "2026-11-11T00:00:00Z" },
  ];
  const lost = lostBoxes(intervals, [
    { id: "c1", status: "provisioning", daytonaSandboxId: null },
    { id: "c2", status: "stopped", daytonaSandboxId: null },
    { id: "c3", status: "stopped", daytonaSandboxId: "box-named" },
  ]);
  assert.deepEqual([...lost], ["box-6041"]);
  // Let go by the abandoned-claim sweep, failed and still naming none: kept.
  assert.deepEqual([...lostBoxes(intervals, [{ id: "c1", status: "error", daytonaSandboxId: null }])], ["box-6041"]);
  // A computer with no row any more: nothing to bring the box back for.
  assert.deepEqual([...lostBoxes(intervals, [])], []);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { bringsBackLostBox, lostBoxes, mayHaveLostBox } from "@/lib/runtime/lost-box";

test("a row claimed or failed with no box may have lost one; a box deleted on purpose, or one named, is not lost", () => {
  assert.equal(mayHaveLostBox({ status: "provisioning", daytonaSandboxId: null }), true);
  assert.equal(mayHaveLostBox({ status: "error", daytonaSandboxId: null }), true);
  // Deleted with its session: stopped, naming none.
  assert.equal(mayHaveLostBox({ status: "stopped", daytonaSandboxId: null }), false);
  assert.equal(mayHaveLostBox({ status: "provisioning", daytonaSandboxId: "box-1" }), false);
  assert.equal(mayHaveLostBox({ status: "ready", daytonaSandboxId: null }), false);
});

test("an open brings a lost box back only once the claim is let go of: a claim still held goes to no one else", () => {
  assert.equal(bringsBackLostBox({ status: "error", daytonaSandboxId: null }), true);
  // Still provisioning: the claim answers "someone else has it", so a box
  // found would go unused; the abandoned-claim sweep lets it go first.
  assert.equal(bringsBackLostBox({ status: "provisioning", daytonaSandboxId: null }), false);
  assert.equal(bringsBackLostBox({ status: "error", daytonaSandboxId: "box-1" }), false);
  assert.equal(bringsBackLostBox({ status: "stopped", daytonaSandboxId: null }), false);
});

test("the orphan sweep keeps a box a row lost: its newest, among the boxes it would delete", () => {
  const candidates = new Set(["box-6041", "box-deleted", "box-stray"]);
  const lost = lostBoxes([
    // The prod row: claimed to bring box 6041 back, cut off by a deploy.
    { status: "provisioning", daytonaSandboxId: null, lastBox: "box-6041" },
    // A session deleted with its box: stopped, naming none.
    { status: "stopped", daytonaSandboxId: null, lastBox: "box-deleted" },
    // A failed row that never ran on a box.
    { status: "error", daytonaSandboxId: null, lastBox: null },
    // Lost, but not a box this run would delete anyway.
    { status: "error", daytonaSandboxId: null, lastBox: "box-elsewhere" },
  ], candidates);
  assert.deepEqual([...lost], ["box-6041"]);
  // Let go of by the abandoned-claim sweep, failed and still naming none: kept.
  assert.deepEqual([...lostBoxes([{ status: "error", daytonaSandboxId: null, lastBox: "box-6041" }], candidates)], ["box-6041"]);
  // No row that lost one: nothing kept.
  assert.deepEqual([...lostBoxes([], candidates)], []);
});

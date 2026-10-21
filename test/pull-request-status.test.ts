import assert from "node:assert/strict";
import { test } from "node:test";

import type { PullRequestStatus } from "@/lib/github/client";
import { pullRequestVerdict } from "@/lib/session/pull-request-status";

const green: PullRequestStatus = {
  state: "open",
  draft: false,
  mergeableState: "clean",
  headSha: "abc",
  checks: { passing: 3, failing: 0, pending: 0 },
};
const verdict = (patch: Partial<PullRequestStatus>) => pullRequestVerdict({ ...green, ...patch });

test("only a green pull request offers Merge", () => {
  assert.deepEqual(verdict({}), { label: "Ready to merge", tone: "ready", canMerge: true });
  assert.equal(verdict({ mergeableState: "has_hooks" }).canMerge, true);
  assert.equal(verdict({ checks: { passing: 0, failing: 0, pending: 0 } }).canMerge, true, "no CI at all is green");
});

test("running or failing checks hold Merge back, whatever GitHub says of merging", () => {
  // A pending check that isn't required leaves GitHub saying "clean" or "unstable".
  assert.deepEqual(verdict({ checks: { passing: 2, failing: 0, pending: 1 } }), {
    label: "Checks running",
    tone: "pending",
    canMerge: false,
  });
  assert.equal(verdict({ checks: { passing: 2, failing: 1, pending: 1 } }).label, "Checks failing");
  assert.equal(verdict({ mergeableState: "unstable", checks: { passing: 0, failing: 0, pending: 0 } }).label, "Checks failing");
});

test("a pull request GitHub won't merge says why", () => {
  assert.equal(verdict({ mergeableState: "dirty" }).label, "Merge conflicts");
  assert.equal(verdict({ mergeableState: "dirty", checks: { passing: 0, failing: 0, pending: 2 } }).label, "Merge conflicts");
  assert.equal(verdict({ mergeableState: "behind" }).label, "Behind base branch");
  assert.equal(verdict({ mergeableState: "blocked" }).label, "Blocked");
  assert.equal(verdict({ mergeableState: "unknown" }).label, "Checking…");
  for (const state of ["dirty", "behind", "blocked", "unknown"]) {
    assert.equal(verdict({ mergeableState: state }).canMerge, false, state);
  }
});

test("merged, closed and draft come before anything else", () => {
  assert.deepEqual(verdict({ state: "merged", mergeableState: "unknown" }), { label: "Merged", tone: "done", canMerge: false });
  assert.equal(verdict({ state: "closed" }).label, "Closed");
  assert.equal(verdict({ draft: true }).label, "Draft");
  assert.equal(verdict({ draft: true }).canMerge, false);
});

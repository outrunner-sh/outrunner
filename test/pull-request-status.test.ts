import assert from "node:assert/strict";
import { test } from "node:test";

import type { PullRequestStatus } from "@/lib/github/client";
import { pullRequestVerdict, supersedingPullRequest, whyNotMergeable } from "@/lib/session/pull-request-status";

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

test("the Review tab offers Merge only as the PR row does, and says why not", () => {
  const why = (patch: Partial<PullRequestStatus>) => whyNotMergeable({ ...green, ...patch });
  assert.equal(why({}), null);
  assert.equal(why({ mergeableState: "has_hooks" }), null);
  // Green checks, but GitHub won't merge it: no Merge, and the reason.
  assert.equal(why({ mergeableState: "dirty" }), "It has merge conflicts with its base branch.");
  assert.equal(why({ mergeableState: "behind" }), "It's behind its base branch.");
  assert.match(why({ mergeableState: "blocked" }) ?? "", /required review or check/);
  assert.match(why({ mergeableState: "unknown" }) ?? "", /still working out/);
  assert.equal(why({ state: "closed" }), "This PR is closed.");
  assert.equal(why({ state: "merged" }), "This PR is merged.");
  assert.equal(why({ draft: true }), "It's a draft.");
  assert.equal(why({ checks: { passing: 1, failing: 1, pending: 0 } }), "Checks are failing.");
  assert.equal(why({ checks: { passing: 1, failing: 0, pending: 1 } }), "Checks are still running.");
});

test("a recorded PR closed unmerged gives way to a newer one from the branch", () => {
  const recorded = { number: 11 };
  const newer = { number: 12, url: "https://github.com/o/r/pull/12", title: "Fix it, on main", baseBranch: "main" };
  assert.deepEqual(supersedingPullRequest(recorded, { ...green, state: "closed" }, newer), newer);
  // The closed one is still the branch's newest: kept.
  assert.equal(supersedingPullRequest(recorded, { ...green, state: "closed" }, { ...newer, number: 11 }), null);
  assert.equal(supersedingPullRequest(recorded, { ...green, state: "closed" }, null), null);
  // Open, merged, or not read: never replaced.
  assert.equal(supersedingPullRequest(recorded, green, newer), null);
  assert.equal(supersedingPullRequest(recorded, { ...green, state: "merged" }, newer), null);
  assert.equal(supersedingPullRequest(recorded, null, newer), null);
});

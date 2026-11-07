import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allPullRequestsDone,
  GIVE_UP_MS,
  isNews,
  isRunnerBranch,
  type PullRequestFacts,
  reviewState,
  runnerOwning,
  settle,
  SETTLE_MS,
} from "@/lib/missions/settle";

const NOW = Date.parse("2026-11-02T12:00:00Z");

function facts(patch: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    state: "open",
    draft: false,
    mergeableState: "clean",
    headSha: "abc",
    checks: { passing: 4, failing: 0, pending: 0 },
    changesRequested: false,
    approved: false,
    ...patch,
  };
}

function decide(patch: Partial<PullRequestFacts> = {}, opts: { quietFor?: number; since?: number; fixRunning?: boolean } = {}) {
  return settle({
    now: NOW,
    firstActivityAt: NOW - (opts.since ?? 10 * 60_000),
    lastActivityAt: NOW - (opts.quietFor ?? SETTLE_MS),
    fixRunning: opts.fixRunning ?? false,
    facts: facts(patch),
  });
}

test("green, mergeable, not a draft: ready, waiting on a review", () => {
  assert.deepEqual(decide(), { kind: "ready", reason: "checks pass and it merges cleanly, waiting on a review" });
  assert.equal(decide({ mergeableState: "has_hooks" }).kind, "ready");
  assert.equal(decide({ mergeableState: "blocked" }).kind, "ready");
  assert.match((decide({ mergeableState: "blocked", approved: true }) as { reason: string }).reason, /approved, and waiting on branch protection/);
  assert.equal(decide({ mergeableState: "behind" }).kind, "ready");
  // unstable: only checks that aren't required failed, and none counted here
  assert.equal(decide({ mergeableState: "unstable" }).kind, "ready");
});

test("anything that blocks it needs attention, with why", () => {
  const reason = (d: ReturnType<typeof decide>) => (d.kind === "needs_attention" ? d.reason : d.kind);
  assert.equal(reason(decide({ draft: true })), "it's still a draft");
  assert.equal(reason(decide({ mergeableState: "dirty" })), "it has merge conflicts");
  assert.equal(reason(decide({ changesRequested: true })), "a reviewer asked for changes");
  assert.equal(reason(decide({ checks: { passing: 2, failing: 1, pending: 0 }, mergeableState: "unstable" })), "1 check failing, with no fix running");
});

test("it waits while activity is recent, checks run, a fix runs, or GitHub hasn't decided", () => {
  assert.equal(decide({}, { quietFor: SETTLE_MS - 1 }).kind, "wait");
  assert.equal(decide({ checks: { passing: 1, failing: 0, pending: 2 } }).kind, "wait");
  // A failing check with a fix running in the Runner: not yet.
  assert.equal(decide({ checks: { passing: 1, failing: 1, pending: 0 } }, { fixRunning: true }).kind, "wait");
  assert.equal(decide({ mergeableState: "unknown" }).kind, "wait");
});

test("past an hour unsettled, waiting turns into needing attention", () => {
  const d = decide({ checks: { passing: 0, failing: 0, pending: 3 } }, { since: GIVE_UP_MS });
  assert.deepEqual(d, { kind: "needs_attention", reason: "it hasn't settled within an hour (checks are still running)" });
  assert.equal(decide({}, { since: GIVE_UP_MS, fixRunning: true }).kind, "needs_attention");
});

test("merged and closed are said as such, whatever else", () => {
  assert.deepEqual(decide({ state: "merged", checks: { passing: 0, failing: 3, pending: 0 } }), { kind: "merged" });
  assert.deepEqual(decide({ state: "closed" }, { quietFor: 0 }), { kind: "closed" });
});

test("a stacked pull request says what it's stacked on", () => {
  const d = decide({ stackedOn: 41 });
  assert.equal(d.kind, "ready");
  assert.match((d as { reason: string }).reason, /stacked on #41/);
});

test("reviews: each reviewer's latest decision counts", () => {
  const r = (id: number, state: string, at: string) => ({ user: { id }, state, submitted_at: `2026-11-02T${at}:00Z` });
  assert.deepEqual(reviewState([]), { changesRequested: false, approved: false });
  assert.deepEqual(reviewState([r(1, "CHANGES_REQUESTED", "10:00"), r(1, "APPROVED", "11:00")]), { changesRequested: false, approved: true });
  assert.deepEqual(reviewState([r(1, "APPROVED", "10:00"), r(2, "CHANGES_REQUESTED", "11:00")]), { changesRequested: true, approved: false });
  // A comment doesn't undo a request for changes; a dismissal does.
  assert.equal(reviewState([r(1, "CHANGES_REQUESTED", "10:00"), r(1, "COMMENTED", "11:00")]).changesRequested, true);
  assert.equal(reviewState([r(1, "CHANGES_REQUESTED", "10:00"), r(1, "DISMISSED", "11:00")]).changesRequested, false);
});

test("a decision is news once: the same again (a redelivered webhook) isn't", () => {
  assert.equal(isNews({ verdict: "ready", sha: "a" }, { verdict: null, sha: null }), true);
  assert.equal(isNews({ verdict: "ready", sha: "a" }, { verdict: "ready", sha: "a" }), false);
  assert.equal(isNews({ verdict: "needs_attention", sha: "a" }, { verdict: "ready", sha: "a" }), true);
  // ready, then changes asked, then ready again on the same head: told each time
  assert.equal(isNews({ verdict: "ready", sha: "a" }, { verdict: "needs_attention", sha: "a" }), true);
  assert.equal(isNews({ verdict: "ready", sha: "b" }, { verdict: "ready", sha: "a" }), true);
});

test("a Runner's branches: its own, and ones named after it for stacked work", () => {
  assert.equal(isRunnerBranch("runtime/abc-1234", "runtime/abc-1234"), true);
  assert.equal(isRunnerBranch("runtime/abc-1234", "runtime/abc-1234-2"), true);
  assert.equal(isRunnerBranch("runtime/abc-1234", "runtime/abc-12345"), false);
  assert.equal(isRunnerBranch("runtime/abc-1234", "runtime/abc-1234-"), false);
  assert.equal(isRunnerBranch("runtime/abc-1234", "main"), false);
});

test("a branch is the Runner's whose branch is the longest it's named after", () => {
  const first = { id: "a", branch: "verify-prs" };
  const second = { id: "b", branch: "verify-prs-2" };
  const runners = [first, second];
  assert.equal(runnerOwning(runners, "verify-prs"), first);
  assert.equal(runnerOwning(runners, "verify-prs-2"), second);
  assert.equal(runnerOwning(runners, "verify-prs-2-2"), second);
  assert.equal(runnerOwning(runners, "verify-prs-3"), first);
  assert.equal(runnerOwning(runners, "main"), undefined);
});

test("a Runner is done only once it has pull requests and all are merged or closed", () => {
  assert.equal(allPullRequestsDone([]), false);
  assert.equal(allPullRequestsDone(["merged", "open"]), false);
  assert.equal(allPullRequestsDone(["merged", "closed"]), true);
});

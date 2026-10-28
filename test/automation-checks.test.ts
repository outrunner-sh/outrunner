import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeCheckWithout,
  closeCheckWithReview,
  type CloseDeps,
  closedWithout,
  type CommentDeps,
  finishCheckFromComment,
  readRunMarker,
  resendReview,
  reviewOutcome,
  reviewScore,
  runMarker,
} from "@/lib/automations/checks";

const RUN = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";

test("a run's marker is hidden HTML, read back from wherever it is in a comment", () => {
  assert.equal(runMarker(RUN), `<!-- outrunner-run:${RUN} -->`);
  assert.equal(readRunMarker(`Looks good.\n\nScore: 5/5\n\n${runMarker(RUN)}`), RUN);
  assert.equal(readRunMarker(`<!--outrunner-run:${RUN.toUpperCase()}-->`), RUN);
  assert.equal(readRunMarker("<!-- outrunner-run:not-a-run -->"), null);
  assert.equal(readRunMarker("Score: 5/5"), null);
});

test("a review's score is read however it's written, and passes the check at 4/5 or more", () => {
  assert.equal(reviewScore("Score: 4/5"), 4);
  assert.equal(reviewScore("**Score: 4.5/5**"), 4.5);
  assert.equal(reviewScore("## Review\n\nscore 3 / 5"), 3);
  assert.equal(reviewScore("4/5 tests pass"), null);
  assert.equal(reviewScore("Score: 7/5"), null);
  // The last: a summary that mentions the earlier pass's first.
  assert.equal(reviewScore("Last pass scored score: 3/5; this one fixes it.\n\nScore: 5/5"), 5);
  const url = "https://github.com/o/r/pull/7#issuecomment-1";
  assert.equal(reviewOutcome("Score: 4/5", url).conclusion, "success");
  assert.equal(reviewOutcome("Score: 5/5", url).output.title, "Score: 5/5");
  // Lower, or no score: neutral, never a failure.
  assert.equal(reviewOutcome("Score: 3.5/5", url).conclusion, "neutral");
  assert.deepEqual(reviewOutcome("Done.", url), {
    conclusion: "neutral",
    output: { title: "Review posted", summary: `The review is [on the pull request](${url}).` },
  });
  assert.deepEqual(closedWithout("It failed."), { conclusion: "neutral", output: { title: "No review", summary: "It failed." } });
});

function comment(over: { login?: string; body?: string; installation?: number; repo?: string; number?: number; pr?: boolean } = {}) {
  return {
    action: "created",
    installation: { id: over.installation ?? 42 },
    repository: { full_name: over.repo ?? "neevai-labs/outrunner" },
    issue: { number: over.number ?? 7, ...(over.pr === false ? {} : { pull_request: { url: "x" } }) },
    comment: {
      user: { login: over.login ?? "outrunner-sh[bot]" },
      body: over.body ?? `Score: 4/5\n${runMarker(RUN)}`,
      html_url: "https://github.com/neevai-labs/outrunner/pull/7#issuecomment-1",
    },
  };
}

function deps() {
  const closed: unknown[] = [];
  const d: CommentDeps = {
    openCheckOf: async (runId) =>
      runId === RUN ? { installationId: 42, repoFullName: "Neevai-Labs/Outrunner", prNumber: 7 } : null,
    closeCheck: async (runId, outcome) => {
      closed.push([runId, outcome.conclusion]);
    },
  };
  return { d, closed };
}

test("the App's own comment with a run's marker closes that run's check with its review", async () => {
  const { d, closed } = deps();
  assert.equal(await finishCheckFromComment(comment(), "outrunner-sh", d), true);
  assert.deepEqual(closed, [[RUN, "success"]]);
});

test("a review's body with the marker closes it too, should the summary be one", async () => {
  const { d, closed } = deps();
  const review = {
    action: "submitted",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    pull_request: { number: 7 },
    review: {
      user: { login: "outrunner-sh[bot]" },
      body: `Score: 3/5\n${runMarker(RUN)}`,
      html_url: "https://github.com/neevai-labs/outrunner/pull/7#pullrequestreview-1",
    },
  };
  assert.equal(await finishCheckFromComment(review, "outrunner-sh", d), true);
  assert.deepEqual(closed, [[RUN, "neutral"]]);
  const other = deps();
  assert.equal(
    await finishCheckFromComment({ ...review, review: { ...review.review, user: { login: "someone" } } }, "outrunner-sh", other.d),
    false,
  );
  assert.equal(await finishCheckFromComment({ ...review, pull_request: { number: 8 } }, "outrunner-sh", other.d), false);
});

test("no one else's comment closes a check, nor the App's on another pull request, repository or installation", async () => {
  const refused: [string, ReturnType<typeof comment>][] = [
    ["someone else's", comment({ login: "someone" })],
    ["another app's", comment({ login: "replicas-connector[bot]" })],
    ["no marker", comment({ body: "Score: 5/5" })],
    ["another pull request", comment({ number: 8 })],
    ["another repository", comment({ repo: "neevai-labs/other" })],
    ["another installation", comment({ installation: 43 })],
    ["an issue, not a pull request", comment({ pr: false })],
    ["edited, not posted", { ...comment(), action: "edited" }],
  ];
  for (const [what, payload] of refused) {
    const { d, closed } = deps();
    assert.equal(await finishCheckFromComment(payload, "outrunner-sh", d), false, what);
    assert.deepEqual(closed, [], what);
  }
  // A run whose check is closed already (or never opened): nothing.
  const { d, closed } = deps();
  const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  assert.equal(await finishCheckFromComment(comment({ body: runMarker(other) }), "outrunner-sh", d), false);
  assert.deepEqual(closed, []);
});

/** The run's row and GitHub's check, in memory, as the deps see them. */
function fakeCheck(over: { failSends?: number } = {}) {
  const row = { exists: true, closedAt: false, reviewedAt: false, review: null as ReturnType<typeof reviewOutcome> | ReturnType<typeof closedWithout> | null };
  const github: string[] = [];
  let failures = over.failSends ?? 0;
  let beforeSend: (() => void) | null = null;
  const deps: CloseDeps<string> = {
    checkStateOf: async () => (row.exists ? { check: "check-1", closed: row.closedAt, review: row.review } : null),
    claimCheck: async () => {
      if (row.closedAt || row.reviewedAt) return false;
      row.closedAt = true;
      return true;
    },
    releaseCheck: async () => {
      if (!row.reviewedAt) row.closedAt = false;
    },
    markCheckReviewed: async (_id, outcome) => {
      row.reviewedAt = true;
      row.review = outcome;
      row.closedAt = false;
    },
    markCheckClosed: async () => {
      row.closedAt = true;
    },
    completeCheck: async (_check, outcome) => {
      const hook = beforeSend;
      beforeSend = null;
      await hook?.();
      if (failures > 0) {
        failures -= 1;
        throw new Error("GitHub 502");
      }
      github.push(outcome.output.title);
    },
  };
  return { row, github, deps, setBeforeSend: (f: () => void) => (beforeSend = f) };
}

const URL_7 = "https://github.com/o/r/pull/7#issuecomment-1";

test("a check closes without a review once, and never once its review is in", async () => {
  const f = fakeCheck();
  await closeCheckWithout(RUN, "It failed.", f.deps);
  await closeCheckWithout(RUN, "The pull request closed.", f.deps);
  assert.deepEqual(f.github, ["No review"]);
  const reviewed = fakeCheck();
  await closeCheckWithReview(RUN, reviewOutcome("Score: 5/5", URL_7), reviewed.deps);
  await closeCheckWithout(RUN, "No review was posted within an hour.", reviewed.deps);
  assert.deepEqual(reviewed.github, ["Score: 5/5"]);
});

test("a close without a review GitHub didn't take is given back for the sweep", async () => {
  const f = fakeCheck({ failSends: 1 });
  await assert.rejects(closeCheckWithout(RUN, "It failed.", f.deps));
  assert.equal(f.row.closedAt, false);
  await closeCheckWithout(RUN, "No review was posted within an hour.", f.deps);
  assert.deepEqual(f.github, ["No review"]);
});

test("a review GitHub didn't take is kept, and the sweep sends it again; nothing says no review meanwhile", async () => {
  const f = fakeCheck({ failSends: 1 });
  await assert.rejects(closeCheckWithReview(RUN, reviewOutcome("Score: 4/5", URL_7), f.deps));
  assert.equal(f.row.closedAt, false);
  assert.equal(f.row.reviewedAt, true);
  // The hour's sweep can't take it for no review...
  await closeCheckWithout(RUN, "No review was posted within an hour.", f.deps);
  assert.deepEqual(f.github, []);
  // ...and sends the review again.
  await resendReview(RUN, f.deps);
  assert.deepEqual(f.github, ["Score: 4/5"]);
  assert.equal(f.row.closedAt, true);
  await resendReview(RUN, f.deps);
  assert.deepEqual(f.github, ["Score: 4/5"]);
});

test("a review after the sweep's close completes the check again, and one landing mid-close is sent after it", async () => {
  const late = fakeCheck();
  await closeCheckWithout(RUN, "No review was posted within an hour.", late.deps);
  await closeCheckWithReview(RUN, reviewOutcome("Score: 5/5", URL_7), late.deps);
  assert.deepEqual(late.github, ["No review", "Score: 5/5"]);

  // The sweep's close is on its way when the review lands: the review's is
  // sent last whichever order GitHub takes them in.
  const racing = fakeCheck();
  racing.setBeforeSend(() => {
    racing.row.reviewedAt = true;
    racing.row.review = reviewOutcome("Score: 5/5", URL_7);
    racing.row.closedAt = false;
  });
  await closeCheckWithout(RUN, "No review was posted within an hour.", racing.deps);
  assert.deepEqual(racing.github, ["No review", "Score: 5/5"]);
  assert.equal(racing.github.at(-1), "Score: 5/5");
});

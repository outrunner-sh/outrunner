import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closedWithout,
  type CommentDeps,
  finishCheckFromComment,
  readRunMarker,
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

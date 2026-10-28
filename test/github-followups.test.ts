import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckRun } from "@/lib/github/ci";
import type { ApiReview, ApiReviewComment } from "@/lib/github/conversation";
import {
  checkState,
  CI_WAIT_MAX_MS,
  ciPrompt,
  type DueFollowUp,
  type FollowUpDeps,
  FOLLOW_UP_EXPIRES_MS,
  flushFollowUps,
  logExcerpt,
  MAX_CI_TURNS,
  queueCiFailure,
  queueReview,
  readCiFailure,
  readReviewSubmitted,
  reviewForSession,
  reviewPrompt,
} from "@/lib/github/followups";
import type { LinkedSession } from "@/lib/github/loop";

const SLUG = "outrunner-connector";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEWER = "fedcba9876543210fedcba9876543210fedcba98";
const NOW = Date.parse("2026-10-28T12:00:00Z");

function suite(over: { conclusion?: string; action?: string; pulls?: unknown[]; app?: string } = {}) {
  return {
    action: over.action ?? "completed",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    check_suite: {
      conclusion: over.conclusion ?? "failure",
      head_sha: SHA,
      head_branch: "feature/login",
      app: { slug: over.app ?? "github-actions" },
      pull_requests: over.pulls ?? [{ number: 30, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } }],
    },
  };
}

test("CI that completed failed is read from check suites, check runs and workflow runs", () => {
  assert.deepEqual(readCiFailure("check_suite", suite(), SLUG), {
    installationId: 42,
    repoFullName: "neevai-labs/outrunner",
    headSha: SHA,
    headBranch: "feature/login",
    prNumbers: [30],
  });
  const run = {
    action: "completed",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    check_run: { conclusion: "timed_out", head_sha: SHA, check_suite: { head_branch: "feature/login" }, pull_requests: [{ number: 30 }] },
  };
  assert.deepEqual(readCiFailure("check_run", run, SLUG)?.prNumbers, [30]);
  const workflow = {
    action: "completed",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    workflow_run: { conclusion: "failure", head_sha: SHA, head_branch: "feature/login", pull_requests: [] },
  };
  assert.deepEqual(readCiFailure("workflow_run", workflow, SLUG)?.prNumbers, []);
});

test("passing, cancelled, unfinished, the App's own and forks' CI start nothing", () => {
  for (const conclusion of ["success", "neutral", "cancelled", "skipped", "action_required"]) {
    assert.equal(readCiFailure("check_suite", suite({ conclusion }), SLUG), null, conclusion);
  }
  assert.equal(readCiFailure("check_suite", suite({ action: "requested" }), SLUG), null);
  assert.equal(readCiFailure("check_suite", suite({ app: "Outrunner-Connector" }), SLUG), null);
  assert.equal(readCiFailure("issues", suite(), SLUG), null);
  const fork = readCiFailure("check_suite", suite({ pulls: [{ number: 31, head: { repo: { id: 2 } }, base: { repo: { id: 1 } } }] }), SLUG);
  assert.deepEqual(fork?.prNumbers, []);
});

function reviewEvent(over: { state?: string; body?: string; user?: Record<string, unknown>; action?: string } = {}) {
  return {
    action: over.action ?? "submitted",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    review: { id: 555, state: over.state ?? "changes_requested", body: over.body ?? "Needs tests", user: { login: "ada", type: "User", ...over.user } },
    pull_request: { number: 30, head: { ref: "feature/login" } },
  };
}

test("a person's submitted review is read; bots', dismissed ones and [skip outrunner] aren't", () => {
  assert.deepEqual(readReviewSubmitted("pull_request_review", reviewEvent()), {
    installationId: 42,
    repoFullName: "neevai-labs/outrunner",
    number: 30,
    reviewId: 555,
    headRef: "feature/login",
  });
  assert.equal(readReviewSubmitted("pull_request_review", reviewEvent({ user: { login: "coderabbit[bot]", type: "Bot" } })), null);
  assert.equal(readReviewSubmitted("pull_request_review", reviewEvent({ state: "dismissed" })), null);
  assert.equal(readReviewSubmitted("pull_request_review", reviewEvent({ action: "edited" })), null);
  assert.equal(readReviewSubmitted("pull_request_review", reviewEvent({ body: "nit [skip outrunner]" })), null);
  assert.equal(readReviewSubmitted("pull_request_review_comment", reviewEvent()), null);
});

test("a log is cut to where it failed, without timestamps or colours", () => {
  const log = [
    "2026-10-28T10:00:00.0000000Z ##[group]Run pnpm test",
    ...Array.from({ length: 100 }, (_, i) => `2026-10-28T10:00:01.0000000Z line ${i}`),
    "2026-10-28T10:00:02.0000000Z \u001b[31m✖ login caches the session\u001b[0m",
    "2026-10-28T10:00:02.0000000Z ##[error]Process completed with exit code 1.",
    "2026-10-28T10:00:03.0000000Z Post job cleanup.",
    "",
  ].join("\n");
  const excerpt = logExcerpt(log);
  const lines = excerpt.split("\n");
  assert.equal(lines.length, 60);
  assert.equal(lines.at(-1), "##[error]Process completed with exit code 1.");
  assert.equal(lines.at(-2), "✖ login caches the session");
  assert.doesNotMatch(excerpt, /Post job cleanup|2026-10-28T/);
  // No error marked: its end.
  assert.equal(logExcerpt("a\nb\nc\n"), "a\nb\nc");
});

function run(over: Partial<CheckRun> & { id: number; name: string }): CheckRun {
  return { status: "completed", conclusion: "success", url: null, app: "github-actions", output: { title: null, summary: null, text: null }, ...over };
}

test("a commit's checks: which failed, and whether any still runs", () => {
  const runs = [
    run({ id: 1, name: "lint" }),
    run({ id: 2, name: "test", conclusion: "failure" }),
    run({ id: 3, name: "build", status: "in_progress", conclusion: null }),
    run({ id: 4, name: "deploy", conclusion: "cancelled" }),
  ];
  const state = checkState(runs);
  assert.deepEqual(
    state.failing.map((r) => r.name),
    ["test"],
  );
  assert.equal(state.running, true);
});

test("a review is sent with only what a person said to the session", () => {
  const review: ApiReview = { id: 1, state: "CHANGES_REQUESTED", body: "Please add tests", html_url: "https://gh/r1", user: { id: 7, login: "ada" } };
  const comments: ApiReviewComment[] = [
    { id: 10, body: "Rename this", path: "lib/a.ts", line: 4, diff_hunk: "@@ -1 +1 @@\n+const x = 1;", user: { id: 7, login: "ada" } },
    { id: 11, body: "@outrunner do this one now", path: "lib/a.ts", line: 9, user: { id: 7, login: "ada" } },
    { id: 12, body: "Not this one [skip outrunner]", path: "lib/b.ts", line: 1, user: { id: 7, login: "ada" } },
  ];
  const kept = reviewForSession(review, comments, SLUG);
  assert.ok(kept);
  assert.equal(kept.state, "changes_requested");
  assert.deepEqual(
    kept.comments.map((c) => c.body),
    ["Rename this"],
  );
  assert.equal(kept.comments[0].where, "`lib/a.ts`, line 4");

  // Changes requested says something to do, comments or not.
  assert.ok(reviewForSession({ ...review, body: "" }, [], SLUG));
  // An approval with nothing on the lines doesn't.
  assert.equal(reviewForSession({ id: 2, state: "APPROVED", body: "LGTM", user: { id: 7, login: "ada" } }, [], SLUG), null);
  assert.equal(reviewForSession({ id: 3, state: "COMMENTED", body: "", user: { id: 7, login: "ada" } }, [comments[1]], SLUG), null);
});

test("the prompts name the pull request, what failed or was said, and where to push", () => {
  const ci = ciPrompt({
    repoFullName: "neevai-labs/outrunner",
    number: 30,
    headSha: SHA,
    headRef: "feature/login",
    failing: [
      { name: "test", conclusion: "failure", url: "https://gh/run/2", excerpt: "✖ login caches the session" },
      { name: "e2e", conclusion: "timed_out", url: null, excerpt: null },
    ],
    turn: 2,
  });
  assert.match(ci, /^CI failed on the pull request this session works on \(neevai-labs\/outrunner#30\), at 0123456:/);
  assert.match(ci, /- test \(failure\): https:\/\/gh\/run\/2\n- e2e \(timed out\)/);
  assert.match(ci, /test:\n```\n✖ login caches the session\n```/);
  assert.match(ci, /git push origin HEAD:feature\/login/);
  assert.match(ci, new RegExp(`fix 2 of at most ${MAX_CI_TURNS}`));

  const reviews = reviewPrompt({
    repoFullName: "neevai-labs/outrunner",
    number: 30,
    headRef: "feature/login",
    reviews: [
      { author: "ada", state: "changes_requested", url: "https://gh/r1", body: "Please add tests", comments: [] },
      { author: "bo", state: "commented", url: null, body: "", comments: [{ author: "bo", url: null, body: "Why?", where: "`a.ts`, line 2", diffHunk: "+x" }] },
    ],
  });
  assert.match(reviews, /^New reviews on the pull request/);
  assert.match(reviews, /@ada requested changes \(https:\/\/gh\/r1\):\n\n> Please add tests/);
  assert.match(reviews, /@bo reviewed:\n\nOn `a\.ts`, line 2:\n```diff\n\+x\n```\n> Why\?/);
});

// ---------------------------------------------------------------------------

type Recorded = {
  queued: Parameters<FollowUpDeps["queue"]>[0][];
  postponed: string[];
  settled: [string, string][];
  sent: { ownerId: string; workspaceId: string; prompt: string; from: string }[];
  comments: string[];
  spoke: string[];
  logs: number[];
};

function fakeDeps(
  options: Partial<FollowUpDeps> & { sessions?: LinkedSession[]; waiting?: DueFollowUp[]; runs?: CheckRun[]; turns?: number } = {},
) {
  const { sessions, waiting, runs, turns: startTurns, ...over } = options;
  const recorded: Recorded = { queued: [], postponed: [], settled: [], sent: [], comments: [], spoke: [], logs: [] };
  const claimed = new Set<string>();
  let turns = startTurns ?? 0;
  const deps: FollowUpDeps = {
    scope: async () => ({ orgId: "o1", projectId: "p1" }),
    claim: async (key) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    linkedSessions: async () => sessions ?? [{ id: "w1", ownerId: "u1" }],
    pullForBranch: async () => 30,
    queue: async (f) => {
      recorded.queued.push(f);
    },
    due: async () => waiting ?? [],
    postpone: async (id) => {
      recorded.postponed.push(id);
    },
    take: async () => {
      turns++;
      if (turns > MAX_CI_TURNS + 1) return { outcome: "quiet", turns: MAX_CI_TURNS };
      if (turns > MAX_CI_TURNS) return { outcome: "capped", turns: MAX_CI_TURNS };
      return { outcome: "send", turns };
    },
    settle: async (id, outcome) => {
      recorded.settled.push([id, outcome]);
    },
    pull: async () => ({ open: true, headSha: SHA, headRef: "feature/login" }),
    checkRuns: async () => runs ?? [run({ id: 2, name: "test", conclusion: "failure" })],
    jobLog: async (_i, _r, jobId) => {
      recorded.logs.push(jobId);
      return "2026-10-28T10:00:02.0000000Z ##[error]boom";
    },
    review: async () => ({ review: { id: 555, state: "CHANGES_REQUESTED", body: "Add tests", user: { id: 7, login: "ada" } }, comments: [] }),
    member: async (githubId) => (githubId === 7 ? "u7" : null),
    canRead: async () => true,
    wakeAndSend: async (ownerId, workspaceId, prompt, from) => {
      recorded.sent.push({ ownerId, workspaceId, prompt, from });
      return true;
    },
    humanSpoke: async (projectId, prNumber) => {
      recorded.spoke.push(`${projectId}#${prNumber}`);
    },
    comment: async (_i, _r, _n, body) => {
      recorded.comments.push(body);
    },
    appSlug: async () => SLUG,
    now: () => NOW,
    ...over,
  };
  return { deps, recorded };
}

function due(over: Partial<DueFollowUp> = {}): DueFollowUp {
  return {
    id: "f1",
    kind: "ci",
    installationId: 42,
    projectId: "p1",
    repoFullName: "neevai-labs/outrunner",
    prNumber: 30,
    headSha: SHA,
    reviewIds: [],
    firstAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

test("CI failing is queued for each linked pull request, by its branch when GitHub names none", async () => {
  const { deps, recorded } = fakeDeps();
  assert.equal(await queueCiFailure("check_suite", suite(), deps, SLUG), 1);
  assert.equal(recorded.queued[0].kind, "ci");
  assert.equal(recorded.queued[0].headSha, SHA);
  assert.equal(recorded.queued[0].prNumber, 30);
  assert.equal(await queueCiFailure("check_suite", suite({ pulls: [] }), deps, SLUG), 1);

  const unlinked = fakeDeps({ sessions: [] });
  assert.equal(await queueCiFailure("check_suite", suite(), unlinked.deps, SLUG), 0);
  assert.equal(unlinked.recorded.queued.length, 0);
});

test("a review is queued into its pull request's batch once, whatever GitHub redelivers", async () => {
  const { deps, recorded } = fakeDeps();
  assert.equal(await queueReview("pull_request_review", reviewEvent(), deps), true);
  assert.equal(await queueReview("pull_request_review", reviewEvent(), deps), false);
  assert.equal(recorded.queued.length, 1);
  assert.equal(recorded.queued[0].reviewId, 555);
});

test("CI's turn goes once its checks are done, with the failing ones' logs, as CI", async () => {
  const runs = [
    run({ id: 2, name: "test", conclusion: "failure" }),
    run({ id: 3, name: "vercel", conclusion: "failure", app: "vercel", output: { title: "Build failed", summary: "Missing env", text: null } }),
    run({ id: 4, name: "lint" }),
  ];
  const { deps, recorded } = fakeDeps({ waiting: [due()], runs });
  assert.deepEqual([...(await flushFollowUps(deps))], [["f1", "sent"]]);
  assert.equal(recorded.sent.length, 1);
  assert.equal(recorded.sent[0].from, "github-ci");
  assert.match(recorded.sent[0].prompt, /- test \(failure\)\n- vercel \(failure\)/);
  assert.match(recorded.sent[0].prompt, /test:\n```\n##\[error\]boom\n```/);
  assert.match(recorded.sent[0].prompt, /vercel:\n```\nBuild failed\n\nMissing env\n```/);
  // Only a workflow's job has a log to read.
  assert.deepEqual(recorded.logs, [2]);
  assert.deepEqual(recorded.settled, [["f1", "sent"]]);
});

test("CI's turn waits for checks still running, but not past its limit", async () => {
  const runs = [run({ id: 2, name: "test", conclusion: "failure" }), run({ id: 3, name: "e2e", status: "in_progress", conclusion: null })];
  const waiting = fakeDeps({ waiting: [due()], runs });
  assert.deepEqual([...(await flushFollowUps(waiting.deps))], [["f1", "waiting"]]);
  assert.deepEqual(waiting.recorded.postponed, ["f1"]);
  assert.equal(waiting.recorded.sent.length, 0);

  const late = fakeDeps({ waiting: [due({ firstAt: new Date(NOW - CI_WAIT_MAX_MS - 1).toISOString() })], runs });
  assert.deepEqual([...(await flushFollowUps(late.deps))], [["f1", "sent"]]);
});

test("CI that passed since, a newer commit, or a closed pull request sends nothing", async () => {
  const passed = fakeDeps({ waiting: [due()], runs: [run({ id: 2, name: "test" })] });
  assert.deepEqual([...(await flushFollowUps(passed.deps))], [["f1", "passed"]]);
  const stale = fakeDeps({ waiting: [due()], pull: async () => ({ open: true, headSha: NEWER, headRef: "feature/login" }) });
  assert.deepEqual([...(await flushFollowUps(stale.deps))], [["f1", "stale"]]);
  const closed = fakeDeps({ waiting: [due()], pull: async () => ({ open: false, headSha: SHA, headRef: "feature/login" }) });
  assert.deepEqual([...(await flushFollowUps(closed.deps))], [["f1", "closed"]]);
  for (const f of [passed, stale, closed]) assert.equal(f.recorded.sent.length, 0);
});

test(`past ${MAX_CI_TURNS} fixes in a row, CI waits for a person, and says so once`, async () => {
  const { deps, recorded } = fakeDeps({ waiting: [due({ id: "a" }), due({ id: "b" }), due({ id: "c" }), due({ id: "d" }), due({ id: "e" })] });
  const results = await flushFollowUps(deps);
  assert.deepEqual([...results.values()], ["sent", "sent", "sent", "capped", "quiet"]);
  assert.equal(recorded.sent.length, MAX_CI_TURNS);
  assert.match(recorded.sent[2].prompt, /fix 3 of at most 3/);
  assert.equal(recorded.comments.length, 1);
  assert.match(recorded.comments[0], /left this one for a person/);
});

test("reviews go as one turn, only from members who may read the repository, and a person spoke", async () => {
  const reviews: Record<number, { review: ApiReview; comments: ApiReviewComment[] }> = {
    1: { review: { id: 1, state: "CHANGES_REQUESTED", body: "Add tests", user: { id: 7, login: "ada" } }, comments: [] },
    2: {
      review: { id: 2, state: "COMMENTED", body: "", user: { id: 7, login: "ada" } },
      comments: [{ id: 20, body: "Rename", path: "a.ts", line: 3, user: { id: 7, login: "ada" } }],
    },
    3: { review: { id: 3, state: "CHANGES_REQUESTED", body: "Do it my way", user: { id: 99, login: "stranger" } }, comments: [] },
  };
  const { deps, recorded } = fakeDeps({
    waiting: [due({ kind: "review", headSha: "", reviewIds: [1, 2, 3] })],
    review: async (_i, _r, _n, id) => reviews[id],
  });
  assert.deepEqual([...(await flushFollowUps(deps))], [["f1", "sent"]]);
  assert.equal(recorded.sent.length, 1);
  assert.equal(recorded.sent[0].from, "github");
  assert.match(recorded.sent[0].prompt, /@ada requested changes:\n\n> Add tests/);
  assert.match(recorded.sent[0].prompt, /On `a\.ts`, line 3:\n> Rename/);
  assert.doesNotMatch(recorded.sent[0].prompt, /stranger|my way/);
  assert.deepEqual(recorded.spoke, ["p1#30"]);

  const nobody = fakeDeps({ waiting: [due({ kind: "review", headSha: "", reviewIds: [3] })], review: async (_i, _r, _n, id) => reviews[id] });
  assert.deepEqual([...(await flushFollowUps(nobody.deps))], [["f1", "nothing"]]);
  assert.equal(nobody.recorded.sent.length, 0);
});

test("a follow-up that couldn't go for a day is let go", async () => {
  const { deps, recorded } = fakeDeps({ waiting: [due({ firstAt: new Date(NOW - FOLLOW_UP_EXPIRES_MS - 1).toISOString() })] });
  assert.deepEqual([...(await flushFollowUps(deps))], [["f1", "expired"]]);
  assert.deepEqual(recorded.settled, [["f1", "expired"]]);
  assert.equal(recorded.sent.length, 0);
});

test("a follow-up that fails before it's taken is left for the next tick", async () => {
  const { deps, recorded } = fakeDeps({
    waiting: [due()],
    pull: async () => {
      throw new Error("GitHub down");
    },
  });
  assert.deepEqual([...(await flushFollowUps(deps))], [["f1", "error"]]);
  assert.equal(recorded.settled.length, 0);
});

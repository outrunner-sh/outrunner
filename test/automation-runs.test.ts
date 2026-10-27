import assert from "node:assert/strict";
import { test } from "node:test";

import { readPullRequestEvent, runPrompt, runTitle, triggerFor } from "@/lib/automations/pull-request";
import { type PendingRun, planRuns, startRun, type StartDeps } from "@/lib/automations/runs";
import type { RunCandidate } from "@/lib/db/automation-runs";
import type { ServerSessionStart } from "@/lib/session/server-session";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function payload(over: { action?: string; pr?: Record<string, unknown>; installation?: unknown } = {}) {
  return {
    action: over.action ?? "opened",
    installation: over.installation ?? { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    pull_request: {
      number: 7,
      title: "Add automations",
      html_url: "https://github.com/neevai-labs/outrunner/pull/7",
      draft: false,
      user: { login: "someone" },
      head: { sha: SHA, ref: "feature/x", repo: { full_name: "neevai-labs/outrunner" } },
      base: { ref: "main", repo: { full_name: "neevai-labs/outrunner" } },
      ...over.pr,
    },
  };
}

const candidate: RunCandidate = {
  automationId: "a1",
  name: "Code Review",
  prompt: "Review it.",
  triggers: ["pull_request.opened", "pull_request.synchronize"],
  runsAs: "u1",
  projectId: "p1",
};

test("opened, reopened and ready for review are reviewed as new; new commits as synchronize", () => {
  assert.equal(triggerFor("opened"), "pull_request.opened");
  assert.equal(triggerFor("reopened"), "pull_request.opened");
  assert.equal(triggerFor("ready_for_review"), "pull_request.opened");
  assert.equal(triggerFor("synchronize"), "pull_request.synchronize");
  for (const other of ["closed", "edited", "labeled", undefined]) assert.equal(triggerFor(other), null);
});

test("a pull request event is read with what a run needs", () => {
  assert.deepEqual(readPullRequestEvent(payload()), {
    installationId: 42,
    trigger: "pull_request.opened",
    repoFullName: "neevai-labs/outrunner",
    number: 7,
    title: "Add automations",
    url: "https://github.com/neevai-labs/outrunner/pull/7",
    headSha: SHA,
    headRef: "feature/x",
    baseRef: "main",
  });
});

test("drafts, forks, bots and other actions start nothing", () => {
  assert.equal(readPullRequestEvent(payload({ action: "closed" })), "action");
  assert.equal(readPullRequestEvent(payload({ pr: { draft: true } })), "draft");
  assert.equal(
    readPullRequestEvent(payload({ pr: { head: { sha: SHA, ref: "x", repo: { full_name: "someone/outrunner" } } } })),
    "fork",
  );
  assert.equal(readPullRequestEvent(payload({ pr: { head: { sha: SHA, ref: "x", repo: null } } })), "fork");
  assert.equal(readPullRequestEvent(payload({ pr: { user: { login: "dependabot[bot]" } } })), "bot");
  assert.equal(readPullRequestEvent(payload({ pr: { user: { login: "renovate[bot]" } } })), "bot");
  // The app's own pull requests, which it would review itself.
  assert.equal(readPullRequestEvent(payload({ pr: { user: { login: "Outrunner-SH[bot]" } } }), "outrunner-sh"), "bot");
  // Another app's (an agent's, opening real changes) are reviewed like anyone's.
  assert.notEqual(readPullRequestEvent(payload({ pr: { user: { login: "replicas-connector[bot]" } } }), "outrunner-sh"), "bot");
  assert.equal(readPullRequestEvent(payload({ installation: { id: "nope" } })), "unreadable");
  assert.equal(readPullRequestEvent(payload({ pr: { head: { sha: "nope", ref: "x", repo: null } } })), "unreadable");
});

test("a run's session is told the pull request, then the automation's prompt", () => {
  const event = readPullRequestEvent(payload({ action: "synchronize" }));
  assert.ok(typeof event !== "string");
  const prompt = runPrompt("Review it.", event);
  assert.match(prompt, /^Pull request: neevai-labs\/outrunner#7 "Add automations"/);
  assert.match(prompt, /gh pr diff 7/);
  assert.match(prompt, /new commits/);
  assert.ok(prompt.endsWith("\n\nReview it."));
  assert.equal(runTitle("Code Review", event), "Code Review #7: Add automations");
  assert.equal(runTitle("Code Review", { ...event, title: "x".repeat(200) }).length, 120);
});

test("an event records one run per matching automation, in one write, once per commit", async () => {
  const recorded = new Set<string>();
  const writes: number[] = [];
  const deps = {
    automationsForPullRequest: async (installationId: number, repo: string) => {
      assert.equal(installationId, 42);
      assert.equal(repo, "neevai-labs/outrunner");
      return [
        candidate,
        { ...candidate, automationId: "a2", triggers: ["pull_request.synchronize" as const] },
        { ...candidate, automationId: "a3" },
      ];
    },
    recordRuns: async (runs: { automationId: string; projectId: string; headSha: string }[]) => {
      writes.push(runs.length);
      const made = new Map<string, string>();
      for (const run of runs) {
        const key = `${run.automationId}:${run.projectId}`;
        if (recorded.has(`${key}@${run.headSha}`)) continue;
        recorded.add(`${key}@${run.headSha}`);
        made.set(key, `run-${run.automationId}`);
      }
      return made;
    },
  };
  const runs = await planRuns(payload(), deps);
  assert.deepEqual(
    runs.map((r) => r.runId),
    ["run-a1", "run-a3"],
  );
  assert.deepEqual(writes, [2]);
  // The same event again (GitHub redelivers): nothing new.
  assert.deepEqual(await planRuns(payload(), deps), []);
  // Nor does one that triggers nothing look anything up.
  assert.deepEqual(
    await planRuns(payload({ pr: { draft: true } }), {
      ...deps,
      automationsForPullRequest: async () => assert.fail("looked up"),
    }),
    [],
  );
  // A write that fails records none of them, so a redelivery starts them all.
  await assert.rejects(
    planRuns(payload({ action: "synchronize", pr: { head: { sha: "f".repeat(40), ref: "x", repo: { full_name: "neevai-labs/outrunner" } } } }), {
      ...deps,
      recordRuns: async () => {
        throw new Error("db down");
      },
    }),
  );
});

function startDeps(over: Partial<StartDeps> = {}) {
  const settled: unknown[] = [];
  const started: ServerSessionStart[] = [];
  const deps: StartDeps = {
    repositoryToken: async () => "ghs_app-token",
    startServerSession: async (start) => {
      started.push(start);
      return { workspaceId: "w1", status: "ready" };
    },
    settleRun: async (_id, outcome) => {
      settled.push(outcome);
    },
    ...over,
  };
  return { deps, settled, started };
}

function pending(over: Partial<RunCandidate> = {}): PendingRun {
  const event = readPullRequestEvent(payload());
  assert.ok(typeof event !== "string");
  return { runId: "r1", candidate: { ...candidate, ...over }, event };
}

test("a run starts its session as the runner, on the pull request's head, with the app's token", async () => {
  const { deps, settled, started } = startDeps();
  await startRun(pending(), deps);
  assert.equal(started.length, 1);
  assert.equal(started[0].userId, "u1");
  assert.equal(started[0].projectId, "p1");
  assert.equal(started[0].baseBranch, "feature/x");
  assert.equal(started[0].githubToken, "ghs_app-token");
  assert.equal(started[0].title, "Code Review #7: Add automations");
  assert.ok(started[0].prompt.endsWith("Review it."));
  assert.deepEqual(settled, [{ status: "ready", workspaceId: "w1", reason: null }]);
});

test("a run says why it didn't start, or failed", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    let { deps, settled, started } = startDeps();
    await startRun(pending({ runsAs: null }), deps);
    assert.equal(started.length, 0);
    assert.equal((settled[0] as { status: string }).status, "refused");

    ({ deps, settled, started } = startDeps({
      repositoryToken: async () => {
        throw new Error("422");
      },
    }));
    await startRun(pending(), deps);
    assert.equal(started.length, 0);
    assert.match((settled[0] as { reason: string }).reason, /token/);

    ({ deps, settled } = startDeps({
      startServerSession: async () => ({ workspaceId: "w2", status: "failed", errorMessage: "No allowance left." }),
    }));
    await startRun(pending(), deps);
    assert.deepEqual(settled, [{ status: "failed", workspaceId: "w2", reason: "No allowance left." }]);

    ({ deps, settled } = startDeps({
      settleRun: async () => {
        throw new Error("db down");
      },
    }));
    await startRun(pending(), deps); // never throws
  } finally {
    console.error = originalError;
  }
});

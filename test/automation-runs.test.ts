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
  orgId: "o1",
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
  // Not told whose comments are its own without the App's slug.
  assert.doesNotMatch(prompt, /\[bot\]/);
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
  const archived: { userId: string; ids: readonly string[] }[] = [];
  const neighbours: unknown[] = [];
  const deps: StartDeps = {
    orgConnector: async () => null,
    runNeighbours: async (run) => {
      neighbours.push(run);
      return { earlierSessions: ["w-old"], superseded: false };
    },
    archiveServerSessions: async (userId, ids) => {
      archived.push({ userId, ids });
      return ids.length;
    },
    startServerSession: async (start) => {
      started.push(start);
      // As createCloudSession: an onCreated that throws fails the session there.
      try {
        await start.onCreated?.("w1");
      } catch {
        return { workspaceId: null, status: "refused", errorMessage: "not recorded" };
      }
      return { workspaceId: "w1", status: "ready" };
    },
    settleRun: async (_id, outcome) => {
      settled.push(outcome);
    },
    ...over,
  };
  return { deps, settled, started, archived, neighbours };
}

function pending(over: Partial<RunCandidate> = {}): PendingRun {
  const event = readPullRequestEvent(payload());
  assert.ok(typeof event !== "string");
  return { runId: "r1", candidate: { ...candidate, ...over }, event };
}

test("a run starts its session as the runner, on the pull request's head, as the App, linked from the first", async () => {
  const { deps, settled, started } = startDeps();
  await startRun(pending(), deps);
  assert.equal(started.length, 1);
  assert.equal(started[0].userId, "u1");
  assert.equal(started[0].projectId, "p1");
  assert.equal(started[0].baseBranch, "feature/x");
  assert.equal(started[0].reviewAsApp, true);
  assert.equal(started[0].title, "Code Review #7: Add automations");
  assert.ok(started[0].prompt.endsWith("Review it."));
  // Linked as soon as its row is made, so its box's token requests are the App's.
  assert.deepEqual(settled, [
    { status: "started", workspaceId: "w1" },
    { status: "ready", workspaceId: "w1", reason: null },
  ]);
});

test("once a run's session is ready, the earlier review sessions are archived as the runner", async () => {
  const { deps, archived, neighbours } = startDeps();
  await startRun(pending(), deps);
  assert.deepEqual(neighbours, [{ runId: "r1", automationId: "a1", projectId: "p1", prNumber: 7 }]);
  assert.deepEqual(archived, [{ userId: "u1", ids: ["w-old"] }]);
});

test("a run ready after a later commit's run began archives its own session, not the newer one", async () => {
  const { deps, archived } = startDeps({
    runNeighbours: async () => ({ earlierSessions: ["w-older"], superseded: true }),
  });
  await startRun(pending(), deps);
  assert.deepEqual(archived, [{ userId: "u1", ids: ["w1"] }]);
});

test("a run that fails keeps the earlier review sessions, and an archive failure fails nothing", async () => {
  let { deps, archived } = startDeps({
    startServerSession: async () => ({ workspaceId: "w2", status: "failed", errorMessage: "x" }),
  });
  await startRun(pending(), deps);
  assert.deepEqual(archived, []);
  const originalError = console.error;
  console.error = () => {};
  try {
    const settled: unknown[] = [];
    ({ deps, archived } = startDeps({
      runNeighbours: async () => {
        throw new Error("db down");
      },
      settleRun: async (_id, outcome) => {
        settled.push(outcome);
      },
    }));
    await startRun(pending(), deps); // never throws
    assert.deepEqual(settled, [
      { status: "started", workspaceId: "w1" },
      { status: "ready", workspaceId: "w1", reason: null },
    ]);
    ({ deps } = startDeps({
      archiveServerSessions: async () => {
        throw new Error("box gone");
      },
    }));
    await startRun(pending(), deps); // nor when archiving does
  } finally {
    console.error = originalError;
  }
});

test("a team org's run is its connector's, whoever set the automation up", async () => {
  const { deps, started } = startDeps({ orgConnector: async (orgId) => (orgId === "o1" ? "connector-1" : null) });
  await startRun(pending(), deps);
  assert.equal(started[0].userId, "connector-1");
  // Even once whoever set it up has left.
  const again = startDeps({ orgConnector: async () => "connector-1" });
  await startRun(pending({ runsAs: null }), again.deps);
  assert.equal(again.started[0].userId, "connector-1");
});

test("a run whose org's connector can't be made doesn't start, saying why", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const { deps, started, settled } = startDeps({
      orgConnector: async () => {
        throw new Error("auth down");
      },
    });
    await startRun(pending(), deps);
    assert.equal(started.length, 0);
    assert.match((settled[0] as { reason: string }).reason, /connector/);
  } finally {
    console.error = originalError;
  }
});

test("a run says why it didn't start, or failed", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const first = startDeps();
    let { deps, settled } = first;
    const { started } = first;
    await startRun(pending({ runsAs: null }), deps);
    assert.equal(started.length, 0);
    assert.equal((settled[0] as { status: string }).status, "refused");

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

test("a run's session is told only the App's bot's comments are its own earlier passes", async () => {
  const event = readPullRequestEvent(payload({ action: "synchronize" }));
  assert.ok(typeof event !== "string");
  const prompt = runPrompt("Review it.", event, "Outrunner-SH");
  assert.match(prompt, /appears as outrunner-sh\[bot\]\. Only its comments are yours/);
  // Its login as `gh api` gives it, not a mention it might copy into a comment.
  assert.doesNotMatch(prompt, /@outrunner-sh/);
  assert.match(prompt, /don't call them a previous pass or a re-run/);
  assert.ok(prompt.endsWith("\n\nReview it."));
  // From the webhook's slug to the session's prompt.
  const runs = await planRuns(
    payload(),
    {
      automationsForPullRequest: async () => [candidate],
      recordRuns: async () => new Map([["a1:p1", "r1"]]),
    },
    "outrunner-sh",
  );
  const { deps, started } = startDeps();
  await startRun(runs[0], deps);
  assert.match(started[0].prompt, /outrunner-sh\[bot\]/);
});

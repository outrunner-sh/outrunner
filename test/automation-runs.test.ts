import assert from "node:assert/strict";
import { test } from "node:test";

import { readClosedPullRequest, readPullRequestEvent, runPrompt, runTitle, triggerFor } from "@/lib/automations/pull-request";
import {
  closeRuns,
  type PendingRun,
  planRuns,
  type RerunDeps,
  rerunRun,
  startRun,
  type StartDeps,
} from "@/lib/automations/runs";
import type { Recorded, RerunTarget, RunCandidate, RunRecord } from "@/lib/db/automation-runs";
import { isPullRequestEvent } from "@/lib/automations/run-event";
import type { ServerSessionStart } from "@/lib/session/server-session";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function payload(over: { action?: string; pr?: Record<string, unknown>; installation?: unknown; repository?: unknown } = {}) {
  return {
    action: over.action ?? "opened",
    installation: over.installation ?? { id: 42 },
    repository: over.repository ?? { full_name: "neevai-labs/outrunner", id: 101 },
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
  repoFullName: "neevai-labs/outrunner",
  orgId: "o1",
  reviewers: [],
  labels: [],
  sessionMode: "new",
};

test("opened, reopened and ready for review are reviewed as new; new commits as synchronize", () => {
  assert.equal(triggerFor("opened"), "pull_request.opened");
  assert.equal(triggerFor("reopened"), "pull_request.opened");
  assert.equal(triggerFor("ready_for_review"), "pull_request.opened");
  assert.equal(triggerFor("synchronize"), "pull_request.synchronize");
  // Closed is merged or not; a review requested is its own.
  assert.equal(triggerFor("closed", true), "pull_request.merged");
  assert.equal(triggerFor("closed", false), "pull_request.closed");
  assert.equal(triggerFor("review_requested"), "pull_request.review_requested");
  for (const other of ["edited", "labeled", "review_request_removed", undefined]) assert.equal(triggerFor(other), null);
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
  assert.equal(readPullRequestEvent(payload({ action: "edited" })), "action");
  assert.equal(readPullRequestEvent(payload({ pr: { draft: true } })), "draft");
  assert.equal(
    readPullRequestEvent(payload({ pr: { head: { sha: SHA, ref: "x", repo: { full_name: "someone/outrunner" } } } })),
    "fork",
  );
  assert.equal(readPullRequestEvent(payload({ pr: { head: { sha: SHA, ref: "x", repo: null } } })), "fork");
  assert.equal(readPullRequestEvent(payload({ pr: { user: { login: "dependabot[bot]" } } })), "bot");
  assert.equal(readPullRequestEvent(payload({ pr: { user: { login: "renovate[bot]" } } })), "bot");
  // The app's own pull requests, which it would review itself.
  assert.equal(readPullRequestEvent(payload({ pr: { user: { login: "Outrunner-Connector[bot]" } } }), "outrunner-connector"), "bot");
  // Another app's (an agent's, opening real changes) are reviewed like anyone's.
  assert.notEqual(readPullRequestEvent(payload({ pr: { user: { login: "replicas-connector[bot]" } } }), "outrunner-connector"), "bot");
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
  // Every run, an automation made from an older template's prompt included.
  assert.match(prompt, /`gh api -F body=@file`/);
  assert.match(prompt, /never `-f body=@file`, which posts the text "@file" itself/);
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
    automationsForPullRequest: async (installationId: number, repoId: number) => {
      assert.equal(installationId, 42);
      // GitHub's id of the repository, never its full name: projects match by it.
      assert.equal(repoId, 101);
      return [
        candidate,
        { ...candidate, automationId: "a2", triggers: ["pull_request.synchronize" as const] },
        { ...candidate, automationId: "a3" },
      ];
    },
    recordRuns: async (runs: RunRecord[]) => {
      writes.push(runs.length);
      const made = new Map<string, Recorded>();
      for (const run of runs) {
        const key = `${run.automationId}:${run.projectId}`;
        if (recorded.has(`${key}@${run.headSha}`)) continue;
        recorded.add(`${key}@${run.headSha}`);
        made.set(key, { runId: `run-${run.automationId}`, queued: false });
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
  // Nor does one that names no repository id: its projects match by it,
  // never by a full name a project's members can set.
  assert.deepEqual(
    await planRuns(payload({ repository: { full_name: "neevai-labs/outrunner" } }), {
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
  const archived: { userId: string; ids: readonly string[]; dropBox?: boolean }[] = [];
  const neighbours: unknown[] = [];
  const checks: string[] = [];
  const deps: StartDeps = {
    orgConnector: async () => null,
    openCheck: async (run) => {
      checks.push(`open ${run.runId}`);
    },
    closeCheck: async (runId, reason) => {
      checks.push(`close ${runId}: ${reason}`);
    },
    runNeighbours: async (run) => {
      neighbours.push(run);
      return { earlierSessions: ["w-old"], superseded: false };
    },
    archiveServerSessions: async (userId, ids, options) => {
      archived.push({ userId, ids, dropBox: options?.dropBox });
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
    waitOutWindow: async () => assert.fail("not queued"),
    reusableSession: async () => assert.fail("a new session each run"),
    continueSession: async () => assert.fail("a new session each run"),
    ...over,
  };
  return { deps, settled, started, archived, neighbours, checks };
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
  assert.deepEqual(archived, [{ userId: "u1", ids: ["w-old"], dropBox: true }]);
});

test("a run ready after a later commit's run began archives its own session, not the newer one", async () => {
  const { deps, archived } = startDeps({
    runNeighbours: async () => ({ earlierSessions: ["w-older"], superseded: true }),
  });
  await startRun(pending(), deps);
  assert.deepEqual(archived, [{ userId: "u1", ids: ["w1"], dropBox: true }]);
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
  const prompt = runPrompt("Review it.", event, "Outrunner-Connector");
  assert.match(prompt, /appears as outrunner-connector\[bot\]\. Its comments are from earlier passes of the App's automations, this one's included/);
  // Its login as `gh api` gives it, not a mention it might copy into a comment.
  assert.doesNotMatch(prompt, /@outrunner-connector/);
  assert.match(prompt, /don't call them a previous pass or a re-run/);
  assert.ok(prompt.endsWith("\n\nReview it."));
  // From the webhook's slug to the session's prompt.
  const runs = await planRuns(
    payload(),
    {
      automationsForPullRequest: async () => [candidate],
      recordRuns: async () => new Map([["a1:p1", { runId: "r1", queued: false }]]),
    },
    "outrunner-connector",
  );
  const { deps, started } = startDeps();
  await startRun(runs[0], deps);
  assert.match(started[0].prompt, /outrunner-connector\[bot\]/);
});

test("a closed or merged pull request is read as such; nothing else is", () => {
  assert.deepEqual(readClosedPullRequest(payload({ action: "closed", pr: { merged: true } })), {
    installationId: 42,
    repoId: 101,
    repoFullName: "neevai-labs/outrunner",
    number: 7,
  });
  // Closed is closed, whoever's or whatever its head: a draft's or a fork's
  // has no runs, which finds none.
  assert.ok(readClosedPullRequest(payload({ action: "closed", pr: { draft: true } })));
  assert.equal(readClosedPullRequest(payload()), null);
  assert.equal(readClosedPullRequest(payload({ action: "synchronize" })), null);
  assert.equal(readClosedPullRequest(payload({ action: "closed", installation: { id: "nope" } })), null);
  assert.equal(readClosedPullRequest(payload({ action: "closed", pr: { number: 0 } })), null);
  // No repository id, nothing to match its projects by: it's no one's.
  assert.equal(readClosedPullRequest(payload({ action: "closed", repository: { full_name: "neevai-labs/outrunner" } })), null);
});

test("a pull request closing archives its review sessions, each as its runner", async () => {
  const asked: unknown[] = [];
  const archived: { userId: string; ids: readonly string[]; dropBox?: boolean }[] = [];
  const deps = {
    pullRequestSessions: async (installationId: number, repoId: number, number: number) => {
      asked.push([installationId, repoId, number]);
      return new Map([
        ["connector-1", ["w1", "w2"]],
        ["u1", ["w3"]],
      ]);
    },
    archiveServerSessions: async (userId: string, ids: readonly string[], options?: { dropBox?: boolean }) => {
      archived.push({ userId, ids, dropBox: options?.dropBox });
      return ids.length;
    },
    openChecksOfPullRequest: async () => ["r1", "r2"],
    closeCheck: async (runId: string, reason: string) => {
      closedChecks.push(`${runId}: ${reason}`);
    },
  };
  const closedChecks: string[] = [];
  assert.equal(await closeRuns(payload({ action: "closed" }), deps), 3);
  // Their checks no review closed say why they never will.
  assert.deepEqual(closedChecks, [
    "r1: The pull request closed before its review was posted.",
    "r2: The pull request closed before its review was posted.",
  ]);
  assert.deepEqual(asked, [[42, 101, 7]]);
  assert.deepEqual(archived, [
    { userId: "connector-1", ids: ["w1", "w2"], dropBox: true },
    { userId: "u1", ids: ["w3"], dropBox: true },
  ]);
  // Any other event looks nothing up.
  assert.equal(
    await closeRuns(payload(), { ...deps, pullRequestSessions: async () => assert.fail("looked up") }),
    0,
  );
});

test("a pull request closing never throws", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const failing = {
      pullRequestSessions: async () => {
        throw new Error("db down");
      },
      archiveServerSessions: async () => 0,
      openChecksOfPullRequest: async () => {
        throw new Error("db down");
      },
      closeCheck: async () => {},
    };
    assert.equal(await closeRuns(payload({ action: "closed" }), failing), 0);
  } finally {
    console.error = originalError;
  }
});

function rerunDeps(over: { target?: Partial<RerunTarget> | null; pr?: Record<string, unknown> } & Partial<RerunDeps> = {}) {
  const reopened: string[] = [];
  const recorded: unknown[] = [];
  const target: RerunTarget | null =
    over.target === null
      ? null
      : {
          runId: "r1",
          status: "failed",
          trigger: "pull_request.opened",
          event: null,
          headSha: SHA,
          prNumber: 7,
          enabled: true,
          atLimit: false,
          candidate,
          repoFullName: "neevai-labs/outrunner",
          installationId: 42,
          installationSuspended: false,
          covered: true,
          workspaceId: "w-failed",
          ...over.target,
        };
  const deps: RerunDeps = {
    rerunTarget: async (orgId, runId) => (orgId === "o1" && runId === "r1" ? target : null),
    pullRequest: async (installationId, repo, number) => {
      assert.deepEqual([installationId, repo, number], [42, "neevai-labs/outrunner", 7]);
      return { state: "open", ...payload().pull_request, ...over.pr };
    },
    reopenRun: async (runId) => {
      reopened.push(runId);
      return reopened.length === 1;
    },
    recordRuns: async (runs) => {
      recorded.push(...runs);
      return new Map([["a1:p1", { runId: "r2", queued: false }]]);
    },
    ...over,
  };
  return { deps, reopened, recorded };
}

test("a run that failed runs again at the same commit as itself, once, told it's the App", async () => {
  const { deps, reopened, recorded } = rerunDeps();
  const rerun = await rerunRun("o1", "r1", deps, "outrunner-connector");
  assert.ok(rerun.ok);
  assert.equal(rerun.run.runId, "r1");
  assert.ok(isPullRequestEvent(rerun.run.event));
  assert.equal(rerun.run.event.headSha, SHA);
  // As newly opened: not told of new commits since a look that may never have been.
  assert.equal(rerun.run.event.trigger, "pull_request.opened");
  assert.equal(rerun.run.appSlug, "outrunner-connector");
  // Its failed session is archived as it starts over: reopening unlinks it.
  assert.equal(rerun.staleSession, "w-failed");
  assert.deepEqual(reopened, ["r1"]);
  assert.deepEqual(recorded, []);
  // Twice at once: the second finds it running again.
  assert.deepEqual(await rerunRun("o1", "r1", deps), { ok: false, status: 409, error: "It's running again already." });
});

test("one whose pull request has moved on runs at its head now, as a new run", async () => {
  const later = "f".repeat(40);
  const { deps, reopened, recorded } = rerunDeps({
    pr: { head: { sha: later, ref: "feature/x", repo: { full_name: "neevai-labs/outrunner" } } },
  });
  const rerun = await rerunRun("o1", "r1", deps);
  assert.ok(rerun.ok);
  assert.equal(rerun.run.runId, "r2");
  // The failed run keeps its session, archived by the new run once it's ready.
  assert.equal(rerun.staleSession, null);
  assert.deepEqual(reopened, []);
  assert.deepEqual(
    (recorded as RunRecord[]).map((record) => ({ ...record, event: undefined })),
    [
      {
        automationId: "a1",
        projectId: "p1",
        trigger: "pull_request.opened",
        dedupeKey: `pr:7:${later}`,
        subject: "pr:7",
        prNumber: 7,
        prTitle: "Add automations",
        headSha: later,
        event: undefined,
      },
    ],
  );
  // Unless that commit has its run already.
  const taken = rerunDeps({
    pr: { head: { sha: later, ref: "feature/x", repo: { full_name: "neevai-labs/outrunner" } } },
    recordRuns: async () => new Map(),
  });
  const refused = await rerunRun("o1", "r1", taken.deps);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /newer commits/);
});

test("a run runs again only when it's the org's, failed or didn't start, and its pull request is open and reviewable", async () => {
  const refusals: [string, Parameters<typeof rerunDeps>[0], number, RegExp][] = [
    ["another org's", { target: null }, 404, /No such run/],
    ["running", { target: { status: "ready" } }, 409, /failed or didn't start/],
    ["starting", { target: { status: "started" } }, 409, /failed or didn't start/],
    ["automation off", { target: { enabled: false } }, 409, /turn it on/],
    ["no installation", { target: { installationId: null } }, 409, /isn't installed/],
    ["installation suspended", { target: { installationId: null, installationSuspended: true } }, 409, /suspended/],
    ["repository taken off", { target: { covered: false } }, 409, /doesn't run on this repository/],
    ["closed", { pr: { state: "closed" } }, 409, /closed/],
    ["draft", { pr: { draft: true } }, 409, /draft/],
  ];
  for (const [what, over, status, error] of refusals) {
    const { deps, reopened } = rerunDeps(over);
    const rerun = await rerunRun("o1", "r1", deps);
    assert.equal(rerun.ok, false, what);
    if (!rerun.ok) {
      assert.equal(rerun.status, status, what);
      assert.match(rerun.error, error, what);
    }
    assert.deepEqual(reopened, [], what);
  }
  // A repository renamed since: the pull request names it as it is now (GitHub
  // redirects), and that's no fork.
  const renamed = { full_name: "neevai-labs/renamed" };
  const moved = await rerunRun(
    "o1",
    "r1",
    rerunDeps({ pr: { head: { sha: SHA, ref: "feature/x", repo: renamed }, base: { ref: "main", repo: renamed } } }).deps,
  );
  assert.ok(moved.ok && isPullRequestEvent(moved.run.event));
  assert.equal(moved.run.event.repoFullName, "neevai-labs/renamed");
  // A refused one runs again too.
  assert.ok((await rerunRun("o1", "r1", rerunDeps({ target: { status: "refused" } }).deps)).ok);
});

test("a run's check opens before anything else, closes saying why when it doesn't run, and stays open for its review", async () => {
  const ready = startDeps();
  await startRun(pending(), ready.deps);
  assert.deepEqual(ready.checks, ["open r1"]);
  // Its session is told how to say its review is in.
  assert.match(ready.started[0].prompt, /<!-- outrunner-run:r1 -->/);
  // As a conversation comment, which the check's webhook hears.
  assert.match(ready.started[0].prompt, /gh pr comment/);

  const failed = startDeps({
    startServerSession: async () => ({ workspaceId: "w2", status: "failed", errorMessage: "No allowance left." }),
  });
  await startRun(pending(), failed.deps);
  assert.deepEqual(failed.checks, ["open r1", "close r1: No allowance left."]);

  const noRunner = startDeps();
  await startRun(pending({ runsAs: null }), noRunner.deps);
  assert.equal(noRunner.checks[0], "open r1");
  assert.match(noRunner.checks[1], /^close r1: Whoever last changed this automation/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { eventDedupeKey, filtersTake, type IssueEvent, issuePrompt, readIssueEvent } from "@/lib/automations/github-events";
import { type PullRequestEvent, readPullRequestEvent, runPrompt } from "@/lib/automations/pull-request";
import { eventBaseBranch, eventSubject, readRunEvent } from "@/lib/automations/run-event";
import { parseAutomationInput } from "@/lib/automations/rules";
import {
  type PendingRun,
  planIssueRuns,
  planQueuedRuns,
  planRuns,
  rerunRun,
  startRun,
  type StartDeps,
} from "@/lib/automations/runs";
import type { Recorded, RerunTarget, RunCandidate, RunRecord } from "@/lib/db/automation-runs";
import type { ServerSessionStart } from "@/lib/session/server-session";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "neevai-labs/outrunner";

function prPayload(action: string, over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) {
  return {
    action,
    installation: { id: 42 },
    repository: { full_name: REPO },
    pull_request: {
      number: 7,
      title: "Add automations",
      html_url: `https://github.com/${REPO}/pull/7`,
      draft: false,
      merged: false,
      user: { login: "someone" },
      head: { sha: SHA, ref: "feature/x", repo: { full_name: REPO } },
      base: { ref: "main", repo: { full_name: REPO } },
      ...pr,
    },
    ...over,
  };
}

function issuePayload(action: string, over: Record<string, unknown> = {}, issue: Record<string, unknown> = {}) {
  return {
    action,
    installation: { id: 42 },
    repository: { full_name: REPO },
    issue: { number: 12, title: "Flaky test", html_url: `https://github.com/${REPO}/issues/12`, user: { login: "someone" }, ...issue },
    ...over,
  };
}

const candidate: RunCandidate = {
  automationId: "a1",
  name: "Triage",
  prompt: "Look.",
  triggers: ["pull_request.review_requested", "issues.labeled", "pull_request.merged"],
  runsAs: "u1",
  projectId: "p1",
  repoFullName: REPO,
  orgId: "o1",
  reviewers: ["Octocat", "neevai-labs/reviewers"],
  labels: ["bug"],
  sessionMode: "new",
};

test("a pull request closed is merged or not, and is run from its base, a fork's too", () => {
  const merged = readPullRequestEvent(prPayload("closed", {}, { merged: true, head: { sha: SHA, ref: "x", repo: { full_name: "fork/outrunner" } } }));
  assert.ok(typeof merged !== "string");
  assert.equal(merged.trigger, "pull_request.merged");
  assert.equal(eventBaseBranch(merged), "main");
  const closed = readPullRequestEvent(prPayload("closed"));
  assert.ok(typeof closed !== "string");
  assert.equal(closed.trigger, "pull_request.closed");
  // A draft closed is still a draft's: it waited, and nothing ran.
  assert.equal(readPullRequestEvent(prPayload("closed", {}, { draft: true })), "draft");
  const prompt = runPrompt("Write release notes.", merged);
  assert.match(prompt, /It was merged into main\. This session's working tree is main, with the merge\./);
  assert.match(runPrompt("x", closed), /closed without being merged/);
});

test("a review requested names whom: a person, or a team as org/slug; a fork's isn't run", () => {
  const person = readPullRequestEvent(prPayload("review_requested", { requested_reviewer: { login: "octocat" } }));
  assert.ok(typeof person !== "string");
  assert.equal(person.reviewer, "octocat");
  assert.equal(eventBaseBranch(person), "feature/x");
  assert.match(runPrompt("Review.", person), /A review of it was just requested of octocat\./);
  const team = readPullRequestEvent(prPayload("review_requested", { requested_team: { slug: "reviewers" } }));
  assert.ok(typeof team !== "string");
  assert.equal(team.reviewer, "neevai-labs/reviewers");
  assert.equal(readPullRequestEvent(prPayload("review_requested")), "unreadable");
  // A review a run's session requested, as the App: marked so.
  const requested = readPullRequestEvent(
    prPayload("review_requested", { requested_reviewer: { login: "octocat" }, sender: { login: "Outrunner-Connector[bot]" } }),
    "outrunner-connector",
  );
  assert.equal((requested as PullRequestEvent).byApp, true);
  assert.equal(
    readPullRequestEvent(
      prPayload("review_requested", { requested_reviewer: { login: "octocat" } }, { head: { sha: SHA, ref: "x", repo: { full_name: "fork/outrunner" } } }),
    ),
    "fork",
  );
  assert.deepEqual(readRunEvent(JSON.parse(JSON.stringify(person))), person);
});

test("an issue opened or labeled is read; a bot's, a pull request's, and other actions aren't", () => {
  const labeled = readIssueEvent(issuePayload("labeled", { label: { name: "bug" } }));
  assert.deepEqual(labeled, {
    installationId: 42,
    trigger: "issues.labeled",
    repoFullName: REPO,
    number: 12,
    title: "Flaky test",
    url: `https://github.com/${REPO}/issues/12`,
    label: "bug",
  });
  assert.equal((readIssueEvent(issuePayload("opened")) as IssueEvent).trigger, "issues.opened");
  assert.equal(readIssueEvent(issuePayload("closed")), "action");
  assert.equal(readIssueEvent(issuePayload("labeled")), "unreadable");
  assert.equal(readIssueEvent(issuePayload("opened", {}, { pull_request: {} })), "unreadable");
  assert.equal(readIssueEvent(issuePayload("opened", {}, { user: { login: "Outrunner-Connector[bot]" } }), "outrunner-connector"), "bot");
  assert.equal(readIssueEvent(issuePayload("opened", {}, { user: { login: "dependabot[bot]" } })), "bot");
  // A run's session labeling a person's issue, as the App: marked so (it
  // starts other automations, not the one that ran there).
  const byRun = readIssueEvent(issuePayload("labeled", { label: { name: "bug" }, sender: { login: "outrunner-connector[bot]" } }), "outrunner-connector");
  assert.equal((byRun as IssueEvent).byApp, true);
  assert.equal((readIssueEvent(issuePayload("labeled", { label: { name: "bug" }, sender: { login: "someone" } }), "outrunner-connector") as IssueEvent).byApp, undefined);
  // A dependency bot's label starts nothing.
  assert.equal(readIssueEvent(issuePayload("labeled", { label: { name: "bug" }, sender: { login: "dependabot[bot]" } })), "bot");
  const event = labeled as IssueEvent;
  assert.equal(eventBaseBranch(event), undefined);
  assert.equal(eventSubject(event), "issue:12");
  const prompt = issuePrompt("Triage it.", event, "outrunner-connector");
  assert.match(prompt, /^Issue: neevai-labs\/outrunner#12 "Flaky test"/);
  assert.match(prompt, /It was just labeled "bug"\./);
  assert.match(prompt, /gh issue view 12 --comments/);
  assert.ok(prompt.endsWith("\n\nTriage it."));
  assert.deepEqual(readRunEvent(JSON.parse(JSON.stringify(event))), event);
});

test("an automation's filters: its reviewers (case aside), its labels or any", () => {
  const review = (reviewer: string) => ({ ...(readPullRequestEvent(prPayload("review_requested", { requested_reviewer: { login: reviewer } })) as PullRequestEvent) });
  assert.ok(filtersTake(candidate, review("octocat")));
  assert.equal(filtersTake(candidate, review("someone-else")), false);
  const label = (name: string) => readIssueEvent(issuePayload("labeled", { label: { name } })) as IssueEvent;
  assert.ok(filtersTake(candidate, label("Bug")));
  assert.equal(filtersTake(candidate, label("docs")), false);
  assert.ok(filtersTake({ ...candidate, labels: [] }, label("docs")));
  assert.ok(filtersTake(candidate, readIssueEvent(issuePayload("opened")) as IssueEvent));
});

test("each event's key makes its run once: a commit's, a merge's, or a delivery's to run again", () => {
  const event = (action: string, over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) =>
    readPullRequestEvent(prPayload(action, over, pr)) as PullRequestEvent;
  assert.equal(eventDedupeKey(event("opened"), "d1"), `pr:7:${SHA}`);
  assert.equal(eventDedupeKey(event("synchronize"), "d1"), `pr:7:${SHA}`);
  assert.equal(eventDedupeKey(event("closed"), "d1"), `pr:7:closed:${SHA}`);
  assert.equal(eventDedupeKey(event("closed", {}, { merged: true }), "d1"), "pr:7:merged");
  const review = event("review_requested", { requested_reviewer: { login: "octocat" } });
  assert.equal(eventDedupeKey(review, "72d3162e-cc78-11e3-81ab-4c9367dc0958"), "gh:72d3162e-cc78-11e3-81ab-4c9367dc0958");
  assert.equal(eventDedupeKey(review, null), `pr:7:review:octocat:${SHA}`);
  assert.equal(eventDedupeKey(review, "not a delivery!"), `pr:7:review:octocat:${SHA}`);
  assert.equal(eventDedupeKey(readIssueEvent(issuePayload("opened")) as IssueEvent, "d1"), "issue:12:opened");
  assert.equal(eventDedupeKey(readIssueEvent(issuePayload("labeled", { label: { name: "bug" } })) as IssueEvent, "d1"), "gh:d1");
});

function planDeps(candidates: RunCandidate[]) {
  const writes: RunRecord[] = [];
  return {
    writes,
    deps: {
      automationsForPullRequest: async () => candidates,
      recordRuns: async (runs: RunRecord[]) => {
        writes.push(...runs);
        return new Map<string, Recorded>(runs.map((r) => [`${r.automationId}:${r.projectId}`, { runId: `run-${r.automationId}`, queued: r.automationId === "a2" }]));
      },
    },
  };
}

test("a review requested runs the automations it's a trigger of, for their reviewers only, keyed by its delivery", async () => {
  const other = { ...candidate, automationId: "a3", reviewers: ["someone-else"] };
  const { deps, writes } = planDeps([candidate, other, { ...candidate, automationId: "a4", triggers: ["pull_request.opened" as const] }]);
  const runs = await planRuns(prPayload("review_requested", { requested_reviewer: { login: "OCTOCAT" } }), deps, undefined, "d-7");
  assert.deepEqual(
    runs.map((r) => r.runId),
    ["run-a1"],
  );
  assert.deepEqual(
    writes.map((w) => [w.trigger, w.dedupeKey, w.subject, w.prNumber, w.headSha]),
    [["pull_request.review_requested", "gh:d-7", "pr:7", 7, SHA]],
  );
});

test("what the App did starts other automations, never one that just ran on the same issue", async () => {
  const triage = { ...candidate, automationId: "triage" };
  const fix = { ...candidate, automationId: "fix" };
  const asked: unknown[] = [];
  const { deps } = planDeps([triage, fix]);
  const labeledByRun = issuePayload("labeled", { label: { name: "bug" }, sender: { login: "outrunner-connector[bot]" } });
  const runs = await planIssueRuns(
    labeledByRun,
    {
      ...deps,
      recentlyRanOn: async (runs, subject, since) => {
        asked.push([runs.map((r) => r.automationId), subject]);
        // A day back: a run may take hours to get to its label.
        assert.ok(Date.now() - since.getTime() >= 23 * 60 * 60_000);
        return new Set(["triage:p1"]);
      },
    },
    "outrunner-connector",
    "d-1",
  );
  // Triage labeled it: the fix runs, triage doesn't run again.
  assert.deepEqual(
    runs.map((r) => r.candidate.automationId),
    ["fix"],
  );
  assert.deepEqual(asked, [[["triage", "fix"], "issue:12"]]);
  // A person's label isn't asked about.
  const byPerson = await planIssueRuns(
    issuePayload("labeled", { label: { name: "bug" }, sender: { login: "someone" } }),
    { ...deps, recentlyRanOn: async () => assert.fail("not the App's") },
    "outrunner-connector",
    "d-2",
  );
  assert.equal(byPerson.length, 2);
  // Without a way to tell, what the App did starts nothing.
  assert.deepEqual(await planIssueRuns(labeledByRun, deps, "outrunner-connector", "d-3"), []);
});

test("an issue labeled runs its automations, as issue runs; one in a debounce window waits", async () => {
  const { deps, writes } = planDeps([candidate, { ...candidate, automationId: "a2" }]);
  const runs = await planIssueRuns(issuePayload("labeled", { label: { name: "bug" } }), deps, "outrunner-connector", "d-9");
  assert.deepEqual(
    runs.map((r) => [r.runId, r.queued ?? false]),
    [
      ["run-a1", false],
      ["run-a2", true],
    ],
  );
  assert.deepEqual(
    writes.map((w) => [w.trigger, w.dedupeKey, w.subject, w.issueNumber, w.prTitle, w.prNumber]),
    [
      ["issues.labeled", "gh:d-9", "issue:12", 12, "Flaky test", undefined],
      ["issues.labeled", "gh:d-9", "issue:12", 12, "Flaky test", undefined],
    ],
  );
  assert.deepEqual(await planIssueRuns(issuePayload("edited"), deps), []);
});

function startDeps(over: Partial<StartDeps> = {}) {
  const started: ServerSessionStart[] = [];
  const settled: unknown[] = [];
  const archived: unknown[] = [];
  const checks: string[] = [];
  const deps: StartDeps = {
    orgConnector: async () => null,
    runNeighbours: async () => ({ earlierSessions: ["w-old"], superseded: false }),
    archiveServerSessions: async (_userId, ids) => {
      archived.push(ids);
      return ids.length;
    },
    startServerSession: async (start) => {
      started.push(start);
      return { workspaceId: "w-new", status: "ready" };
    },
    settleRun: async (_id, outcome) => {
      settled.push(outcome);
    },
    waitOutWindow: async () => assert.fail("not queued"),
    reusableSession: async () => null,
    continueSession: async () => assert.fail("nothing to continue"),
    openCheck: async (run) => {
      checks.push(`open ${run.runId}`);
    },
    closeCheck: async (runId) => {
      checks.push(`close ${runId}`);
    },
    ...over,
  };
  return { deps, started, settled, archived, checks };
}

const review = readPullRequestEvent(prPayload("synchronize")) as PullRequestEvent;
const issue = readIssueEvent(issuePayload("opened")) as IssueEvent;

test("a run in a debounce window starts once it passes, as the last trigger it took in, saying how many", async () => {
  const { deps, started } = startDeps({ waitOutWindow: async () => ({ event: issue, combined: 3 }) });
  await startRun({ runId: "r1", candidate, event: review, queued: true }, deps);
  assert.equal(started.length, 1);
  assert.match(started[0].prompt, /^3 triggers came within this automation's debounce window; this run is for the last of them\.\n\nIssue:/);
  // Taken by another (the tick, or a later trigger's wait): nothing here.
  const taken = startDeps({ waitOutWindow: async () => null });
  await startRun({ runId: "r1", candidate, event: review, queued: true }, taken.deps);
  assert.equal(taken.started.length, 0);
  assert.deepEqual(taken.settled, []);
});

test("reusing its session, a run is sent to the automation's last one; one that can't be woken is replaced", async () => {
  const reuse = { ...candidate, sessionMode: "reuse" as const };
  const sent: unknown[] = [];
  const asked: unknown[] = [];
  const { deps, started, settled, archived } = startDeps({
    reusableSession: async (run) => {
      asked.push(run);
      return "w-last";
    },
    continueSession: async (userId, workspaceId, prompt) => {
      sent.push([userId, workspaceId, prompt]);
      return true;
    },
  });
  await startRun({ runId: "r1", candidate: reuse, event: review }, deps);
  assert.equal(started.length, 0);
  assert.deepEqual(settled, [{ status: "ready", workspaceId: "w-last", reason: null }]);
  const [[userId, workspaceId, prompt]] = sent as [string, string, string][];
  assert.equal(userId, "u1");
  assert.equal(workspaceId, "w-last");
  assert.match(prompt, /^This session ran this automation before.*gh pr checkout 7/);
  assert.match(prompt, /Pull request: neevai-labs\/outrunner#7/);
  assert.deepEqual(archived, []);
  // Its session on this pull request, not another's that may be mid-run.
  assert.deepEqual(asked, [{ runId: "r1", automationId: "a1", projectId: "p1", subject: "pr:7" }]);
  // A merge's run is told to start from the base, not the pull request's
  // head (which may be gone).
  const merged = readPullRequestEvent(prPayload("closed", {}, { merged: true })) as PullRequestEvent;
  const toBase: string[] = [];
  await startRun(
    { runId: "r3", candidate: reuse, event: merged },
    startDeps({
      reusableSession: async () => "w-last",
      continueSession: async (_u, _w, prompt) => {
        toBase.push(prompt);
        return true;
      },
    }).deps,
  );
  assert.match(toBase[0], /^This session ran this automation before.*first, check out main and pull it\./);
  assert.doesNotMatch(toBase[0], /gh pr checkout/);
  // None to reuse, or it won't wake: a new one, and nothing archived (the
  // next run reuses it).
  const fresh = startDeps({ reusableSession: async () => "w-gone", continueSession: async () => false });
  await startRun({ runId: "r2", candidate: reuse, event: review }, fresh.deps);
  assert.equal(fresh.started.length, 1);
  assert.deepEqual(fresh.archived, []);
});

test("only a review of a pull request's head takes over from earlier ones", async () => {
  const merged = readPullRequestEvent(prPayload("closed", {}, { merged: true })) as PullRequestEvent;
  const { deps, started, archived, checks } = startDeps({ runNeighbours: async () => assert.fail("a merge's run stands alone") });
  await startRun({ runId: "r1", candidate, event: merged }, deps);
  assert.equal(started[0].baseBranch, "main");
  assert.deepEqual(archived, []);
  // Nor has it a check: it isn't a review of the pull request's code, and
  // isn't told a run id to mark one with.
  assert.deepEqual(checks, []);
  assert.doesNotMatch(started[0].prompt, /outrunner-run:/);
  const onHead = startDeps();
  await startRun({ runId: "r2", candidate, event: review }, onHead.deps);
  assert.deepEqual(onHead.checks, ["open r2"]);
  assert.match(onHead.started[0].prompt, /outrunner-run:r2/);
});

test("the tick starts runs whose window passed, and says why one can't", async () => {
  const settled: unknown[] = [];
  const pending: PendingRun[] = await planQueuedRuns(
    new Date(),
    {
      claimQueuedRuns: async () => [
        { runId: "r1", automationId: "a1", projectId: "p1", event: issue, combined: 2 },
        { runId: "r2", automationId: "a1", projectId: "p-gone", event: issue, combined: 1 },
        { runId: "r3", automationId: "a1", projectId: "p1", event: null, combined: 1 },
      ],
      claimedCandidates: async () => [candidate],
      settleRun: async (runId, outcome) => {
        assert.equal(outcome.status, "refused");
        settled.push([runId, outcome.reason]);
      },
    },
    "outrunner-connector",
  );
  assert.deepEqual(
    pending.map((p) => [p.runId, p.combined, p.queued ?? false, p.appSlug]),
    [["r1", 2, false, "outrunner-connector"]],
  );
  assert.deepEqual(settled, [
    ["r2", "The automation doesn't run on this repository any more."],
    ["r3", "Its event couldn't be read back to start it."],
  ]);
});

function target(over: Partial<RerunTarget>): RerunTarget {
  return {
    runId: "r1",
    status: "failed",
    trigger: "pull_request.merged",
    event: readPullRequestEvent(prPayload("closed", {}, { merged: true })) as PullRequestEvent,
    headSha: SHA,
    prNumber: 7,
    enabled: true,
    atLimit: false,
    candidate,
    repoFullName: REPO,
    installationId: 42,
    installationSuspended: false,
    covered: true,
    workspaceId: "w-failed",
    ...over,
  };
}

test("a failed run of a merge starts again as itself; one of an automation done with its count still does", async () => {
  const deps = (t: RerunTarget) => ({
    rerunTarget: async () => t,
    pullRequest: async () => assert.fail("a merged pull request isn't read again"),
    reopenRun: async () => true,
    recordRuns: async () => assert.fail("no new run"),
  });
  // A review's run again, at a newer head, of a debounced automation: its
  // new run waits out the window, and is taken once.
  const later = "f".repeat(40);
  const queuedRerun = await rerunRun("o1", "r1", {
    rerunTarget: async () => target({ trigger: "pull_request.synchronize", event: null }),
    pullRequest: async () => ({ state: "open", ...prPayload("synchronize", {}, { head: { sha: later, ref: "feature/x", repo: { full_name: REPO } } }).pull_request }),
    reopenRun: async () => assert.fail("a new run, not this one"),
    recordRuns: async () => new Map([["a1:p1", { runId: "r9", queued: true }]]),
  });
  assert.ok(queuedRerun.ok);
  assert.equal(queuedRerun.run.queued, true);
  const merged = await rerunRun("o1", "r1", deps(target({})));
  assert.ok(merged.ok);
  assert.equal(merged.run.event.trigger, "pull_request.merged");
  // Off because it ran its count: the failed one is one of them. Off by
  // hand before it, it doesn't run.
  assert.ok((await rerunRun("o1", "r1", deps(target({ enabled: false, atLimit: true })))).ok);
  const off = await rerunRun("o1", "r1", deps(target({ enabled: false })));
  assert.equal(off.ok, false);
});

const A = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
const base = { name: "Triage", prompt: "Look.", projectIds: [A] };

test("an automation's filters and limits are checked as they're saved", () => {
  const ok = parseAutomationInput(
    {
      ...base,
      triggers: ["pull_request.review_requested", "issues.labeled"],
      reviewers: ["@octocat", "Octocat", "neevai-labs/reviewers"],
      labels: ["bug", " needs triage "],
      maxRuns: 1,
      archiveWhenDone: true,
      debounceSeconds: 300,
      sessionMode: "reuse",
    },
    { full: true },
  );
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.reviewers, ["octocat", "neevai-labs/reviewers"]);
  assert.deepEqual(ok.value.labels, ["bug", "needs triage"]);
  assert.equal(ok.value.maxRuns, 1);
  assert.equal(ok.value.sessionMode, "reuse");
  const refused: [string, unknown][] = [
    ["review requested of no one", { ...base, triggers: ["pull_request.review_requested"], reviewers: [] }],
    ["a reviewer that isn't a login", { ...base, triggers: ["issues.opened"], reviewers: ["not a login"] }],
    ["too many labels", { ...base, triggers: ["issues.opened"], labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }],
    ["no runs", { ...base, triggers: ["issues.opened"], maxRuns: 0 }],
    ["a fraction of a run", { ...base, triggers: ["issues.opened"], maxRuns: 1.5 }],
    ["a window past the hour", { ...base, triggers: ["issues.opened"], debounceSeconds: 7200 }],
    ["a session neither new nor reused", { ...base, triggers: ["issues.opened"], sessionMode: "shared" }],
  ];
  for (const [what, body] of refused) assert.equal(parseAutomationInput(body, { full: true }).ok, false, what);
  // Archiving, or bringing one back, is a change of its own.
  const archived = parseAutomationInput({ archived: true }, { full: false });
  assert.ok(archived.ok);
  assert.deepEqual(archived.value, { archived: true });
  assert.equal(parseAutomationInput({ archived: "yes" }, { full: false }).ok, false);
  // Every time again.
  const every = parseAutomationInput({ maxRuns: null }, { full: false });
  assert.ok(every.ok);
  assert.equal(every.value.maxRuns, null);
});

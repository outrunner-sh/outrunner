import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AgentRow } from "@/lib/db/linear-agent";
import type { TrackerScope } from "@/lib/db/trackers";
import type { TrackerNote } from "@/lib/db/work-items";
import { declinedHere, type FollowingItem, pullRequestsChanged, sessionStartedHere, type WriteBackDeps } from "@/lib/trackers/write-back";
import type { WorkItem } from "@/lib/triage/work-items";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "item-1",
    number: 1,
    projectId: null,
    title: "T",
    body: "",
    status: "in_progress",
    source: "linear",
    sourceUrl: null,
    sourceRef: "linear:issue-1",
    sourceAuthor: null,
    duplicateOf: null,
    workspaceId: "w",
    prompt: null,
    triagedAt: null,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
    ...over,
  };
}

const following = (over: Partial<WorkItem> = {}): FollowingItem => ({ orgId: "org", item: item(over), installationId: "install", issueId: "issue-1" });

const row: AgentRow = { agentSessionId: "agent-1", installationId: "install", orgId: "org", issueId: "issue-1", itemId: "item-1", workspaceId: "w", ownerId: "u", stage: "working", prompt: null, ruleStarted: false, ask: null, askedUser: null };

function harness(setup: { items?: FollowingItem[]; rows?: AgentRow[]; inReview?: string | null; stateType?: string; scopeOrg?: string } = {}, over: Partial<WriteBackDeps> = {}) {
  const log = { comments: [] as string[], attached: [] as string[], urls: [] as { label: string; url: string }[], states: [] as string[], closed: [] as unknown[], notes: [] as TrackerNote[] };
  const deps: WriteBackDeps = {
    itemById: async () => setup.items?.[0] ?? null,
    itemsOfSession: async () => setup.items ?? [following()],
    rowsOfSession: async () => setup.rows ?? [],
    pullRequestUrl: async () => "https://github.com/a/b/pull/7",
    comment: async (_i, _issue, body) => void log.comments.push(body),
    attach: async (_i, _issue, url) => void log.attached.push(url),
    addUrl: async (_i, _a, url) => void log.urls.push(url),
    setIssueState: async (_i, _issue, state) => void log.states.push(state),
    standing: async () => ({ teamId: "team", stateType: setup.stateType ?? "started" }),
    scopeForTeam: async () => ({ orgId: setup.scopeOrg === undefined ? "org" : setup.scopeOrg, stateMap: { started: "st", inReview: setup.inReview === undefined ? "st-review" : setup.inReview } }) as TrackerScope,
    close: async (_o, _i, close) => void log.closed.push(close),
    addNote: async (_o, _i, note) => void log.notes.push(note),
    sessionUrl: (id) => `https://app/workspaces/${id}`,
    ...over,
  };
  return { deps, log };
}

const change = (to: string) => ({ workspaceId: "w", projectId: "p", from: null, to, number: 7 });

test("declining posts one comment; an item not following an issue posts none", async () => {
  const one = harness({ items: [following()] });
  await declinedHere("item-1", one.deps);
  assert.deepEqual(one.log.comments, ["Declined in Outrunner's Triage."]);
  const none = harness({ items: [] });
  await declinedHere("item-1", none.deps);
  assert.deepEqual(none.log.comments, []);
});

test("a session started here comments once, naming who, and moves nothing", async () => {
  const { deps, log } = harness({ items: [following()] });
  await sessionStartedHere("org", "item-1", "ana", "w", deps);
  assert.deepEqual(log.comments, ["Session started by ana: [open it in Outrunner](https://app/workspaces/w)"]);
  assert.deepEqual(log.states, []);
});

test("a session started with another org's item says nothing there: its token isn't this org's", async () => {
  const { deps, log } = harness({ items: [following()] });
  await sessionStartedHere("another-org", "item-1", "ana", "w", deps);
  assert.deepEqual(log.comments, []);
});

test("a session only tells a tracker once its item is really on it, and only for that org", () => {
  const create = readFileSync("lib/session/create-cloud-session.ts", "utf8");
  assert.match(create, /if \(await linkWorkItemToSession\(actor, workItemId[^\n]*\{\n\s*void tellTrackersSessionStarted\(orgId, workItemId/);
  assert.equal(create.match(/tellTrackersSessionStarted\(/g)?.length, 1);
  const items = readFileSync("lib/db/work-items.ts", "utf8");
  assert.match(items, /\(triager \? update : update\.is\("workspace_id", null\)\)\.select\("id"\)/, "a no-op says so");
});

test("a PR opened on a delegated session goes on the agent session, and moves the issue to In Review", async () => {
  const { deps, log } = harness({ rows: [row] });
  await pullRequestsChanged([change("open")], deps);
  assert.deepEqual(log.urls, [{ label: "PR #7", url: "https://github.com/a/b/pull/7" }]);
  assert.deepEqual(log.states, ["st-review"]);
  assert.deepEqual(log.attached, []);
});

test("stopped or un-delegated isn't delegated: its PR is attached, and the issue doesn't move", async () => {
  const { deps, log } = harness({ rows: [{ ...row, stage: "stopped" }] });
  await pullRequestsChanged([change("open")], deps);
  assert.deepEqual(log.urls, []);
  assert.deepEqual(log.attached, ["https://github.com/a/b/pull/7"]);
  assert.deepEqual(log.states, []);
});

test("a PR's link is read by its repository: a session of several can have the same number in two", async () => {
  const asked: unknown[] = [];
  const { deps } = harness({ rows: [row] }, {
    pullRequestUrl: async (...args) => {
      asked.push(args);
      return "https://github.com/a/b/pull/7";
    },
  });
  await pullRequestsChanged([change("open")], deps);
  assert.deepEqual(asked, [["w", "p", 7]]);
});

test("a PR opened on a session started here is attached to the issue, and moves nothing", async () => {
  const { deps, log } = harness();
  await pullRequestsChanged([change("open")], deps);
  assert.deepEqual(log.attached, ["https://github.com/a/b/pull/7"]);
  assert.deepEqual(log.urls, []);
  assert.deepEqual(log.states, []);
});

test("a team with no In Review state, as a new workspace has, just isn't moved", async () => {
  const { deps, log } = harness({ rows: [row], inReview: null });
  await pullRequestsChanged([change("open")], deps);
  assert.deepEqual(log.states, []);
  assert.equal(log.urls.length, 1);
});

test("an issue already closed isn't moved to In Review", async () => {
  for (const stateType of ["completed", "canceled", "duplicate"]) {
    const { deps, log } = harness({ rows: [row], stateType });
    await pullRequestsChanged([change("open")], deps);
    assert.deepEqual(log.states, [], stateType);
  }
});

test("a merged PR makes an open item done, and sets nothing in Linear", async () => {
  const { deps, log } = harness({ rows: [row] });
  await pullRequestsChanged([change("merged")], deps);
  assert.deepEqual(log.closed, [{ status: "done" }]);
  assert.deepEqual(log.states, []);
  assert.deepEqual(log.comments, []);
});

test("a merged PR leaves a decision made here as it is", async () => {
  for (const status of ["declined", "duplicate", "done"] as const) {
    const { deps, log } = harness({ items: [following({ status })] });
    await pullRequestsChanged([change("merged")], deps);
    assert.deepEqual(log.closed, [], status);
  }
});

test("a PR closed without merging is a note, once, and nothing back", async () => {
  const { deps, log } = harness({ rows: [row] });
  await pullRequestsChanged([change("closed")], deps);
  assert.match(log.notes[0].body, /closed without merging/);
  assert.equal(log.notes[0].sourceRef, "pr:w:7:closed");
  assert.deepEqual(log.closed, []);
  assert.deepEqual(log.urls, []);
});

test("a session with no item following an issue does nothing", async () => {
  const { deps, log } = harness({ items: [] });
  await pullRequestsChanged([change("open"), change("merged")], deps);
  assert.deepEqual(log.attached, []);
  assert.deepEqual(log.closed, []);
});

test("one change failing doesn't stop the next", async () => {
  const error = console.error;
  console.error = () => undefined;
  let calls = 0;
  try {
    const { deps, log } = harness(
      {},
      {
        itemsOfSession: async () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          return [following()];
        },
      },
    );
    await pullRequestsChanged([change("open"), change("merged")], deps);
    assert.deepEqual(log.closed, [{ status: "done" }]);
  } finally {
    console.error = error;
  }
});

test("Jira: a delegated issue's PR is a link on the issue and moves it, and a closed PR's note says it's Jira's", async () => {
  const links: { url: string; label: string }[] = [];
  const states: string[] = [];
  const notes: TrackerNote[] = [];
  const following: FollowingItem = { orgId: "o", item: item({ source: "jira", sourceRef: "jira:cloud/1" }), installationId: "i", issueId: "1" };
  const deps: WriteBackDeps = {
    itemById: async () => following,
    itemsOfSession: async () => [following],
    // Jira's row is the issue.
    rowsOfSession: async () => [{ agentSessionId: "1", issueId: "1", stage: "working" }],
    pullRequestUrl: async () => "https://github.test/a/b/pull/7",
    comment: async () => undefined,
    attach: async () => assert.fail("delegated: on the row"),
    addUrl: async (_i, _a, url) => void links.push(url),
    setIssueState: async (_i, _issue, state) => void states.push(state),
    standing: async () => ({ teamId: "10000", stateType: "started" }),
    scopeForTeam: async () => ({ id: "s", installationId: "i", orgId: "o", externalTeamId: "10000", name: null, setBy: null, stateMap: { started: "3", inReview: "4" }, defaultProjectId: null, acceptRuleSessions: false, ruleSessionsPerDay: 20 }),
    close: async () => undefined,
    addNote: async (_o, _i, note) => void notes.push(note),
    sessionUrl: (id) => `https://app.test/workspaces/${id}`,
  };
  await pullRequestsChanged([{ workspaceId: "w", projectId: "p", to: "open", from: null, number: 7 }], deps);
  assert.deepEqual(links, [{ label: "PR #7", url: "https://github.test/a/b/pull/7" }]);
  assert.deepEqual(states, ["4"]);
  await pullRequestsChanged([{ workspaceId: "w", projectId: "p", to: "closed", from: "open", number: 7 }], deps);
  assert.equal(notes[0]?.source, "jira");
});

test("an org no longer connected to the issue's team tells it nothing: decline, session, PR", async () => {
  const gone = () => harness({ items: [following()], scopeOrg: "someone-else", rows: [row] });
  const declined = gone();
  await declinedHere("item-1", declined.deps);
  assert.deepEqual(declined.log.comments, []);
  const started = gone();
  await sessionStartedHere("org", "item-1", "ana", "w", started.deps);
  assert.deepEqual(started.log.comments, []);
  const opened = gone();
  await pullRequestsChanged([change("open")], opened.deps);
  assert.deepEqual(opened.log.urls, []);
  assert.deepEqual(opened.log.attached, []);
  assert.deepEqual(opened.log.states, []);
  // What's only here still happens.
  const merged = gone();
  await pullRequestsChanged([change("merged")], merged.deps);
  assert.equal(merged.log.closed.length, 1);
});

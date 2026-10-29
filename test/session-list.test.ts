import assert from "node:assert/strict";
import { test } from "node:test";

import { filterSessions, NO_FILTER, othersStanding, ownSessionEntries, ownerChoices, type SessionListEntry } from "@/lib/session/session-list";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import type { AppData } from "@/lib/session/session-view";
import type { SessionStanding } from "@/lib/session/standing";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const placed = (standing: SessionStanding["standing"]): SessionStanding => ({
  standing,
  reason: null,
  moved: false,
  pinned: false,
  unread: false,
  replyPreview: null,
  at: "2026-10-28T11:00:00Z",
});
const entry = (id: string, patch: Partial<SessionListEntry> = {}): SessionListEntry => ({
  id,
  title: `Session ${id}`,
  branch: `runtime/${id}`,
  project: "acme/api",
  owner: { id: "me", name: "Ada", login: "ada", avatarUrl: null },
  mine: true,
  local: false,
  source: "app",
  createdAt: "2026-10-28T10:00:00Z",
  at: "2026-10-28T11:00:00Z",
  status: "ready",
  provider: "daytona",
  pullRequest: null,
  standing: placed("done"),
  ...patch,
});

const entries = [
  entry("a", { createdAt: "2026-10-27T10:00:00Z", title: "Fix login" }),
  entry("b", { createdAt: "2026-10-28T09:00:00Z", source: "slack", standing: placed("needs_you") }),
  entry("c", { createdAt: "2026-10-28T10:00:00Z", mine: false, owner: { id: "u2", name: "Grace", login: "grace", avatarUrl: null } }),
  entry("d", { createdAt: "2026-10-26T10:00:00Z", source: "mac", local: true, standing: null, at: "2026-10-01T00:00:00Z" }),
];
const ids = (list: SessionListEntry[]) => list.map((e) => e.id);

test("newest first, all of them with no filter", () => {
  assert.deepEqual(ids(filterSessions(entries, NO_FILTER, NOW)), ["c", "b", "a", "d"]);
});

test("filters by owner, source and where it stands; a Mac session's standing is worked out", () => {
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, owner: "me" }, NOW)), ["b", "a", "d"]);
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, owner: "u2" }, NOW)), ["c"]);
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, source: "slack" }, NOW)), ["b"]);
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, status: "needs_you" }, NOW)), ["b"]);
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, status: "backlog" }, NOW)), ["d"]);
});

test("search matches title, branch without runtime/, repository and owner", () => {
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, query: "LOGIN" }, NOW)), ["a"]);
  assert.deepEqual(ids(filterSessions(entries, { ...NO_FILTER, query: "grace" }, NOW)), ["c"]);
  assert.equal(filterSessions(entries, { ...NO_FILTER, query: "runtime" }, NOW).length, 0);
  assert.equal(filterSessions(entries, { ...NO_FILTER, query: "acme/api" }, NOW).length, 4);
});

test("the owner filter offers the user first, then others by name, once each", () => {
  assert.deepEqual(
    ownerChoices(entries).map((o) => o.name),
    ["Ada", "Grace"],
  );
});

test("another member's session shows where it stands, never what its agent said", () => {
  const theirs = { ...placed("done"), unread: true, replyPreview: "the secret plan" };
  assert.deepEqual(othersStanding(theirs), { ...theirs, unread: false, replyPreview: null });
  assert.equal(othersStanding(undefined), null);
});

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "p1",
    ownerId: "u1",
    provider: "daytona",
    agent: "claude",
    model: null,
    mode: "build",
    status: "ready",
    phase: "claude_ready",
    branch: `runtime/${id}`,
    title: null,
    baseBranch: "main",
    worktreePath: "",
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    environmentId: null,
    checkouts: null,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: "2026-10-28T10:00:00Z",
    updatedAt: "2026-10-28T10:00:00Z",
    ...over,
  };
}

function project(id: string, fullName: string): Project {
  const [owner, name] = fullName.split("/");
  return {
    id,
    githubRepoId: 1,
    fullName,
    owner,
    name,
    defaultBranch: "main",
    private: true,
    language: null,
    description: null,
    htmlUrl: `https://github.com/${fullName}`,
    pushedAt: null,
    linearIssueIds: [],
    orgId: "org-1",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

const pullRequest: WorkspacePullRequest = {
  id: "pr1",
  workspaceId: "w1",
  projectId: "p1",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Fix",
  baseBranch: "main",
  headBranch: "runtime/w1",
  createdAt: "2026-10-28T10:00:00Z",
};

const layout = (over: Partial<AppData> = {}): AppData => ({
  projects: [project("p1", "o/r")],
  hiddenProjects: [],
  workspaces: [],
  pullRequests: {},
  ...over,
});

test("the layout's own sessions are rows: titled, named by repository, standing and all", () => {
  const w = workspace("w1", { title: "Fix login", lastActiveAt: "2026-10-28T11:30:00Z" });
  assert.deepEqual(ownSessionEntries(layout({ workspaces: [w] })), [
    {
      id: "w1",
      title: "Fix login",
      branch: "runtime/w1",
      project: "o/r",
      // The user's own, and the layout doesn't carry their name; the column
      // shows "You" for one's own session anyway.
      owner: { id: "u1", name: "You", login: null, avatarUrl: null },
      mine: true,
      local: false,
      source: "app",
      createdAt: "2026-10-28T10:00:00Z",
      at: "2026-10-28T11:30:00Z",
      status: "ready",
      provider: "daytona",
      pullRequest: null,
      standing: null,
    },
  ]);
  // A session from before titles, and one in a repository the sidebar hides.
  assert.equal(ownSessionEntries(layout({ workspaces: [workspace("w2")] }))?.[0].title, "w2");
  assert.equal(
    ownSessionEntries(layout({ workspaces: [workspace("w3", { projectId: "p2" })], hiddenProjects: [project("p2", "o/hidden")] }))?.[0]
      .project,
    "o/hidden",
  );
});

test("a row's pull request and where it stands come from the layout too", () => {
  const rows = ownSessionEntries(
    layout({
      workspaces: [workspace("w1")],
      pullRequests: { w1: pullRequest },
      standings: { w1: placed("needs_you") },
    }),
  );
  assert.deepEqual(rows?.[0].pullRequest, { url: "https://github.com/o/r/pull/7", number: 7, state: "open" });
  assert.equal(rows?.[0].standing?.standing, "needs_you");
});

test("where a session was started reads as its own row says; triage is the server's to say", () => {
  const rows = ownSessionEntries(
    layout({
      workspaces: [
        workspace("a"),
        workspace("b", { source: "slack" }),
        workspace("c", { source: "app", slackThreadUrl: "https://slack.com/thread" }),
        workspace("d", { source: "automation" }),
        workspace("e", { source: "github" }),
        workspace("f", { source: "api" }),
      ],
    }),
  );
  assert.deepEqual(
    rows?.map((r) => r.source),
    ["app", "slack", "slack", "automation", "app", "app"],
  );
});

test("no layout data is nothing known, which is not the same as no sessions", () => {
  assert.equal(ownSessionEntries(null), null);
  assert.deepEqual(ownSessionEntries(layout()), []);
});

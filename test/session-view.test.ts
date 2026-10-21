import assert from "node:assert/strict";
import { test } from "node:test";

import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { newerSessionView, resolveSessionView, type AppData, type SessionView } from "@/lib/session/session-view";

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "p1",
    ownerId: "u1",
    provider: "daytona",
    agent: "claude",
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
    lastActiveAt: null,
    errorMessage: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const pr: WorkspacePullRequest = {
  id: "pr1",
  workspaceId: "w1",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Fix",
  baseBranch: "main",
  headBranch: "runtime/w1",
  createdAt: "2026-10-02T00:00:00Z",
};

const data = (workspaces: Workspace[], pullRequests: AppData["pullRequests"] = {}): AppData => ({
  projects: [{ id: "p1", name: "r", fullName: "o/r" }],
  workspaces,
  pullRequests,
});

test("a session the sidebar has shows from it: its repository and pull request too", () => {
  const w1 = workspace("w1");
  assert.deepEqual(resolveSessionView("w1", data([w1, workspace("w2")], { w1: pr })), {
    workspace: w1,
    projectName: "o/r",
    pullRequest: pr,
  });
});

test("no pull request, or a repository the sidebar doesn't name, still shows", () => {
  const w = workspace("w1", { projectId: "unknown" });
  assert.deepEqual(resolveSessionView("w1", data([w])), { workspace: w, projectName: undefined, pullRequest: null });
});

test("one the sidebar doesn't have, a deleted one, or no sidebar at all is the server's to say", () => {
  assert.equal(resolveSessionView("w9", data([workspace("w1")])), null);
  assert.equal(resolveSessionView("w1", data([workspace("w1", { status: "destroyed" })])), null);
  assert.equal(resolveSessionView("w1", null), null);
});

const view = (updatedAt: string, id = "w1"): SessionView => ({
  workspace: workspace(id, { updatedAt }),
  pullRequest: null,
});

test("with both the sidebar's and the server's, the newer row shows; the sidebar's on a tie", () => {
  const older = view("2026-10-01T00:00:00Z");
  const newer = view("2026-10-01T00:05:00Z");
  assert.equal(newerSessionView("w1", older, newer), newer);
  assert.equal(newerSessionView("w1", newer, older), newer);
  const tie = view("2026-10-01T00:00:00Z");
  assert.equal(newerSessionView("w1", older, tie), older);
});

test("either alone shows; neither is nothing yet", () => {
  const v = view("2026-10-01T00:00:00Z");
  assert.equal(newerSessionView("w1", v, null), v);
  assert.equal(newerSessionView("w1", null, v), v);
  assert.equal(newerSessionView("w1", null, null), null);
});

test("the server's read of the session open before doesn't stand in for this one", () => {
  // Moving between sessions, the last one's answer is still held a moment.
  assert.equal(newerSessionView("w2", null, view("2026-10-01T00:00:00Z", "w1")), null);
  const sidebar = view("2026-10-01T00:00:00Z", "w2");
  assert.equal(newerSessionView("w2", sidebar, view("2026-10-09T00:00:00Z", "w1")), sidebar);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalSession } from "@/lib/desktop/local-runtime";
import type { Workspace } from "@/lib/runtime/types";
import { RECENT_SESSION_LIMIT, recentSessionGroups, recentSessions, type RecentSession } from "@/lib/session/recent-sessions";

const projects = [{ id: "p1", name: "app", fullName: "acme/app" }];
function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id, projectId: "p1", ownerId: "me", provider: "daytona", status: "ready", phase: null,
    branch: `runtime/${id}`, title: `Task ${id}`, baseBranch: "main", worktreePath: "",
    sandboxId: null, volumeName: null, computerId: null, tmuxSession: null, agentWorkspaceId: null,
    environmentId: null, checkouts: null, agent: "claude", model: null, mode: "build",
    lastActiveAt: null, errorMessage: null, createdAt: "2026-10-30T08:00:00Z", updatedAt: "2026-10-30T08:00:00Z",
    ...patch,
  };
}
function local(id: string, patch: Partial<LocalSession> = {}): LocalSession {
  return {
    workspaceId: id, name: "notes", title: `Local ${id}`, folder: "/Users/ada/notes", worktree: `/w/${id}`,
    branch: `runtime/${id}`, baseBranch: "main", inPlace: false, createdAt: "2026-10-30T09:00:00Z", running: false,
    ...patch,
  };
}

test("cloud and Mac sessions share a list ordered by activity, with their own destinations", () => {
  const rows = recentSessions([
    workspace("old"),
    workspace("used", { lastActiveAt: "2026-10-30T10:00:00Z" }),
    workspace("new", { createdAt: "2026-10-30T11:00:00Z" }),
  ], [local("mac")], projects);
  assert.deepEqual(rows.map((row) => [row.href, row.project, row.local]), [
    ["/workspaces/new", "acme/app", false],
    ["/workspaces/used", "acme/app", false],
    ["/local/mac", "notes", true],
    ["/workspaces/old", "acme/app", false],
  ]);
});

test("Runners are resumable, while child Ships and archived or deleted sessions stay out", () => {
  const rows = recentSessions([
    workspace("runner", { kind: "mission" }),
    workspace("ship", { parentMissionId: "runner" }),
    workspace("archived", { status: "archived" }),
    workspace("archiving", { status: "archiving" }),
    workspace("deleted", { status: "destroyed" }),
    workspace("starting", { status: "provisioning" }),
    workspace("failed", { status: "failed" }),
  ], [], projects);
  assert.deepEqual(rows.map((row) => row.id), ["failed", "runner", "starting"]);
});

test("five most recent distinct destinations are shown, without conflating cloud and Mac ids", () => {
  const rows = recentSessions([
    workspace("same", { lastActiveAt: "2026-10-30T12:00:00Z", title: "Newest" }),
    workspace("same", { lastActiveAt: "2026-10-30T10:00:00Z" }),
    ...Array.from({ length: 8 }, (_, i) => workspace(String(i))),
  ], [local("same", { lastActiveAt: "2026-10-30T11:00:00Z" })], projects);
  assert.equal(RECENT_SESSION_LIMIT, 5);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].title, "Newest");
  assert.deepEqual(rows.slice(0, 2).map((row) => row.href), ["/workspaces/same", "/local/same"]);
  assert.equal(new Set(rows.map((row) => row.href)).size, 5);
});

test("invalid last activity falls back to creation; wholly invalid times sort last", () => {
  const rows = recentSessions([
    workspace("bad", { createdAt: "invalid", lastActiveAt: "invalid" }),
    workspace("fallback", { createdAt: "2026-10-30T10:00:00Z", lastActiveAt: "invalid" }),
  ], [local("older", { lastActiveAt: "invalid" })], projects);
  assert.deepEqual(rows.map((row) => row.id), ["fallback", "older", "bad"]);
  assert.equal(rows[0].at, "2026-10-30T10:00:00Z");
  assert.equal(rows[1].at, "2026-10-30T09:00:00Z");
});

test("timestamps compare as instants across offsets and fractional seconds", () => {
  const rows = recentSessions([
    workspace("older", { lastActiveAt: "2026-10-30T12:00:00Z" }),
    workspace("newer", { lastActiveAt: "2026-10-30T17:30:00.5+05:30" }),
  ], [], projects);
  assert.deepEqual(rows.map((row) => row.id), ["newer", "older"]);
});

test("untitled and hidden-project sessions keep the same labels as the sidebar", () => {
  const rows = recentSessions([workspace("cloud", { title: null, projectId: "hidden" })], [local("mac", { title: "" })], []);
  assert.deepEqual(rows.map((row) => [row.title, row.project]), [["mac", "notes"], ["cloud", "Repository"]]);
});

test("sorting and deduplication do not modify the shared input arrays", () => {
  const cloud = Object.freeze([workspace("z"), workspace("a")]);
  const mac = Object.freeze([local("mac")]);
  recentSessions(cloud, mac, projects);
  assert.deepEqual(cloud.map((row) => row.id), ["z", "a"]);
  assert.equal(mac.length, 1);
  assert.deepEqual(recentSessions([], [], projects), []);
});

function row(id: string, date: Date | string): RecentSession {
  return { id, href: `/workspaces/${id}`, title: id, project: "app", at: typeof date === "string" ? date : date.toISOString(), local: false };
}

test("groups use local calendar boundaries, omit empty groups, and retain session order", () => {
  const now = new Date(2026, 9, 30, 12).getTime();
  const groups = recentSessionGroups([
    row("today", new Date(2026, 9, 30, 0)),
    row("yesterday", new Date(2026, 9, 29, 23, 59)),
    row("earlier", new Date(2026, 9, 28, 23, 59)),
    row("invalid", "invalid"),
  ], now);
  assert.deepEqual(groups.map((group) => [group.label, group.sessions.map((session) => session.id)]), [
    ["Today", ["today"]], ["Yesterday", ["yesterday"]], ["Earlier", ["earlier", "invalid"]],
  ]);
  assert.deepEqual(recentSessionGroups([], now), []);
});

for (const [month, day] of [[2, 9], [10, 2]]) {
  test(`yesterday is a calendar day across the ${month === 2 ? "spring" : "autumn"} DST transition`, () => {
    const now = new Date(2026, month, day, 0, 30).getTime();
    const groups = recentSessionGroups([
      row("today", new Date(2026, month, day, 0, 1)),
      row("yesterday", new Date(2026, month, day - 1, 0, 15)),
      row("earlier", new Date(2026, month, day - 2, 23, 59)),
    ], now);
    assert.deepEqual(groups.map((group) => group.label), ["Today", "Yesterday", "Earlier"]);
  });
}

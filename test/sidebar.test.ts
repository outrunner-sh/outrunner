import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalSession } from "@/lib/desktop/local-runtime";
import {
  activeSessionId,
  buildSidebarGroups,
  deletionConsequence,
  filterSidebarGroups,
  FOLDED_PROJECTS_COOKIE,
  foldedProjectsCookie,
  isStudioPath,
  newSessionHref,
  readFoldedProjects,
  relativeTime,
  shownSessions,
  UNSTARTED_SHOWN,
} from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";

const project = (id: string, name = id): NavProject => ({ id, name, fullName: `acme/${name}` });

function workspace(id: string, projectId: string, at: string, title: string | null = null): Workspace {
  return {
    id,
    projectId,
    ownerId: "user-1",
    provider: "daytona",
    status: "ready",
    phase: null,
    branch: `runtime/${id}`,
    title,
    baseBranch: "main",
    worktreePath: "",
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    environmentId: null,
    checkouts: null,
    agent: "claude",
    model: null,
    mode: "build",
    lastActiveAt: at,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function local(
  id: string,
  folder: string,
  createdAt: string,
  title = `task ${id}`,
  lastActiveAt?: string,
): LocalSession {
  return {
    workspaceId: id,
    name: folder.split("/").at(-1)!,
    title,
    folder,
    worktree: `/w/${id}`,
    branch: `runtime/${id}`,
    baseBranch: "main",
    inPlace: false,
    createdAt,
    lastActiveAt,
    running: false,
  };
}

test("cloud repositories and Mac folders share one list, newest activity first", () => {
  const groups = buildSidebarGroups(
    [project("p1", "outrunner"), project("p2", "neev-ai")],
    [
      workspace("w1", "p1", "2026-10-01T00:00:00Z"),
      workspace("w2", "p2", "2026-10-05T00:00:00Z"),
    ],
    [local("l1", "/Users/ada/notes", "2026-10-03T00:00:00Z")],
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.local]),
    [
      ["neev-ai", false],
      ["notes", true],
      ["outrunner", false],
    ],
  );
});

test("sessions nest under their workspace, newest first, with links and times", () => {
  const [group] = buildSidebarGroups(
    [project("p1", "outrunner")],
    [
      workspace("old", "p1", "2026-10-01T00:00:00Z", "Pull latest code from main"),
      workspace("new", "p1", "2026-10-02T00:00:00Z"),
    ],
    [],
  );
  assert.equal(group.detail, "acme/outrunner");
  assert.deepEqual(group.start, { kind: "cloud", projectId: "p1" });
  assert.deepEqual(group.sessions, [
    {
      id: "new",
      href: "/workspaces/new",
      title: "new",
      branch: "runtime/new",
      at: "2026-10-02T00:00:00Z",
      archivable: true,
      deletion: null,
    },
    {
      id: "old",
      href: "/workspaces/old",
      title: "Pull latest code from main",
      branch: "runtime/old",
      at: "2026-10-01T00:00:00Z",
      archivable: true,
      deletion: null,
    },
  ]);
});

test("a Mac folder links its sessions to /local and starts new ones in the folder", () => {
  const [group] = buildSidebarGroups(
    [],
    [],
    [
      local("a", "/Users/ada/app", "2026-10-01T00:00:00Z", "Write the README"),
      local("b", "/Users/ada/app", "2026-10-04T00:00:00Z", ""),
    ],
    { startLocal: true },
  );
  assert.equal(group.key, "local:/Users/ada/app");
  assert.equal(group.detail, "/Users/ada/app");
  assert.deepEqual(group.start, { kind: "local", folder: "/Users/ada/app" });
  // Newest first; an untitled session falls back to its branch.
  assert.deepEqual(
    group.sessions.map((s) => [s.href, s.title]),
    [
      ["/local/b", "b"],
      ["/local/a", "Write the README"],
    ],
  );
});

test("a session whose repository is not listed still appears, under a placeholder", () => {
  const groups = buildSidebarGroups([], [workspace("w1", "hidden", "2026-10-01T00:00:00Z")], []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Repository");
  assert.equal(groups[0].sessions[0].href, "/workspaces/w1");
});

test("nothing to show is an empty list", () => {
  assert.deepEqual(buildSidebarGroups([], [], []), []);
});

test("a project with no session yet is listed, empty, after the ones with sessions", () => {
  const groups = buildSidebarGroups(
    [project("p1", "fresh"), project("p2", "outrunner"), project("p3", "newer")],
    [workspace("w1", "p2", "2026-10-01T00:00:00Z")],
    [local("l1", "/Users/ada/notes", "2026-09-01T00:00:00Z")],
  );
  // Started ones by activity, then the rest in the list's order.
  assert.deepEqual(
    groups.map((g) => [g.label, g.sessions.length]),
    [
      ["outrunner", 1],
      ["notes", 1],
      ["fresh", 0],
      ["newer", 0],
    ],
  );
  // Each can start its first session.
  assert.deepEqual(groups[2], {
    key: "cloud:p1",
    label: "fresh",
    detail: "acme/fresh",
    local: false,
    start: { kind: "cloud", projectId: "p1" },
    sessions: [],
  });
});

test("only the few projects connected last are listed with no session, newest first", () => {
  const made = (id: string, day: number) => ({ ...project(id), createdAt: `2026-10-0${day}T00:00:00Z` });
  const groups = buildSidebarGroups(
    [made("a", 1), made("b", 5), made("c", 3), made("d", 4), made("e", 2), made("busy", 1)],
    [workspace("w1", "busy", "2026-10-06T00:00:00Z")],
    [],
  );
  assert.equal(UNSTARTED_SHOWN, 3);
  assert.deepEqual(groups.map((g) => g.label), ["busy", "b", "d", "c"]);
});

test("search finds a project with no session by its name, and drops it otherwise", () => {
  const groups = buildSidebarGroups([project("p1", "fresh")], [], []);
  assert.deepEqual(filterSidebarGroups(groups, "FRE").map((g) => g.label), ["fresh"]);
  assert.deepEqual(filterSidebarGroups(groups, "billing"), []);
});

test("group keys stay distinct between a repository and a folder of the same name", () => {
  const groups = buildSidebarGroups(
    [project("app")],
    [workspace("w1", "app", "2026-10-02T00:00:00Z")],
    [local("l1", "app", "2026-10-01T00:00:00Z")],
  );
  const keys = groups.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("a Mac session ranks by its last use, not by when it was made", () => {
  const groups = buildSidebarGroups(
    [project("p1", "outrunner")],
    [workspace("w1", "p1", "2026-10-05T00:00:00Z")],
    [
      // Made weeks ago, used today: above the cloud session from two days ago.
      local("l1", "/Users/ada/notes", "2026-09-01T00:00:00Z", "Notes", "2026-10-07T09:00:00Z"),
    ],
  );
  assert.deepEqual(groups.map((g) => g.label), ["notes", "outrunner"]);
  assert.equal(groups[0].sessions[0].at, "2026-10-07T09:00:00Z");
});

test("a Mac session from an agent without lastActiveAt falls back to when it was made", () => {
  const [group] = buildSidebarGroups([], [], [local("l1", "/x/app", "2026-09-01T00:00:00Z")]);
  assert.equal(group.sessions[0].at, "2026-09-01T00:00:00Z");
});

test("times are compared as instants, not as text", () => {
  // As text, "12:00:00Z" sorts after "12:00:00.001Z", and Postgres writes
  // "+00:00" where the agent writes "Z". Newest by instant must still win.
  const groups = buildSidebarGroups(
    [project("p1", "cloud-newer"), project("p2", "cloud-older")],
    [
      workspace("w1", "p1", "2026-10-07T12:00:00.001+00:00"),
      workspace("w2", "p2", "2026-10-07T11:59:59.999+00:00"),
    ],
    [local("l1", "/x/mac", "2026-10-07T12:00:00Z")],
  );
  assert.deepEqual(groups.map((g) => g.label), ["cloud-newer", "mac", "cloud-older"]);
});

test("a session's own group lists its newest first even across time formats", () => {
  const [group] = buildSidebarGroups(
    [project("p1")],
    [
      workspace("a", "p1", "2026-10-07T12:00:00+00:00"),
      workspace("b", "p1", "2026-10-07T12:00:00.5+00:00"),
    ],
    [],
  );
  assert.deepEqual(group.sessions.map((s) => s.id), ["b", "a"]);
});

test("only a group with a real repository behind it can start a session", () => {
  const groups = buildSidebarGroups(
    [project("p1", "outrunner")],
    [workspace("w1", "p1", "2026-10-02T00:00:00Z"), workspace("w2", "gone", "2026-10-01T00:00:00Z")],
    [],
  );
  assert.deepEqual(groups.map((g) => [g.label, g.start]), [
    ["outrunner", { kind: "cloud", projectId: "p1" }],
    ["Repository", null],
  ]);
});

const sample = () =>
  buildSidebarGroups(
    [project("p1", "outrunner"), project("p2", "neev-ai")],
    [
      workspace("w1", "p1", "2026-10-02T00:00:00Z", "Fix login redirect"),
      workspace("w2", "p1", "2026-10-01T00:00:00Z", "Add billing page"),
      workspace("w3", "p2", "2026-10-03T00:00:00Z", "Login copy tweaks"),
    ],
    [],
  );

test("search keeps matching sessions, case-insensitively, and drops empty workspaces", () => {
  const result = filterSidebarGroups(sample(), "BILLING");
  assert.deepEqual(
    result.map((g) => [g.label, g.sessions.map((s) => s.title)]),
    [["outrunner", ["Add billing page"]]],
  );
});

test("search across workspaces keeps their order", () => {
  const result = filterSidebarGroups(sample(), "login");
  assert.deepEqual(
    result.map((g) => [g.label, g.sessions.map((s) => s.title)]),
    [
      ["neev-ai", ["Login copy tweaks"]],
      ["outrunner", ["Fix login redirect"]],
    ],
  );
});

test("a workspace whose name matches keeps every session", () => {
  const result = filterSidebarGroups(sample(), "outrun");
  assert.equal(result.length, 1);
  assert.equal(result[0].sessions.length, 2);
});

test("search finds a session by its branch, but not by the runtime/ they all have", () => {
  const groups = buildSidebarGroups(
    [project("p1", "outrunner")],
    [
      { ...workspace("w1", "p1", "2026-10-02T00:00:00Z", "Fix login redirect"), branch: "feat/oauth-callback" },
      workspace("w2", "p1", "2026-10-01T00:00:00Z", "Add billing page"),
    ],
    [{ ...local("l1", "/Users/ada/notes", "2026-10-03T00:00:00Z", "Tidy notes"), branch: "md/notes-cleanup" }],
  );
  const titles = (query: string) => filterSidebarGroups(groups, query).flatMap((g) => g.sessions.map((s) => s.title));
  assert.deepEqual(titles("OAUTH"), ["Fix login redirect"]);
  assert.deepEqual(titles("cleanup"), ["Tidy notes"]);
  // A generated branch is found by its own part (runtime/w2).
  assert.deepEqual(titles("w2"), ["Add billing page"]);
  assert.deepEqual(titles("runtime"), []);
});

test("a blank search changes nothing; no match leaves nothing", () => {
  const groups = sample();
  assert.equal(filterSidebarGroups(groups, "   "), groups);
  assert.deepEqual(filterSidebarGroups(groups, "zzz"), []);
});

test("the active session is read from session paths only", () => {
  assert.equal(activeSessionId("/workspaces/abc"), "abc");
  assert.equal(activeSessionId("/workspaces/abc/replay"), "abc");
  assert.equal(activeSessionId("/local/xyz"), "xyz");
  assert.equal(activeSessionId("/"), undefined);
  assert.equal(activeSessionId("/new"), undefined);
  assert.equal(activeSessionId("/settings/general"), undefined);
});

test("only a session's own page is a studio path", () => {
  assert.equal(isStudioPath("/workspaces/abc"), true);
  assert.equal(isStudioPath("/workspaces/abc/"), true);
  assert.equal(isStudioPath("/local/xyz"), true);
  // Its replay has no studio header to hold the sidebar's buttons.
  assert.equal(isStudioPath("/workspaces/abc/replay"), false);
  assert.equal(isStudioPath("/workspaces"), false);
  assert.equal(isStudioPath("/"), false);
  assert.equal(isStudioPath("/new"), false);
});

test("relative times step from now through minutes, hours, days, weeks, months, years", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const m = 60_000, h = 60 * m, d = 24 * h;
  assert.equal(relativeTime(ago(10_000), now), "now");
  assert.equal(relativeTime(ago(5 * m), now), "5m");
  assert.equal(relativeTime(ago(59 * m), now), "59m");
  assert.equal(relativeTime(ago(60 * m), now), "1h");
  assert.equal(relativeTime(ago(23 * h), now), "23h");
  assert.equal(relativeTime(ago(1 * d), now), "1d");
  assert.equal(relativeTime(ago(6 * d), now), "6d");
  assert.equal(relativeTime(ago(7 * d), now), "1w");
  assert.equal(relativeTime(ago(29 * d), now), "4w");
  assert.equal(relativeTime(ago(30 * d), now), "1mo");
  assert.equal(relativeTime(ago(364 * d), now), "12mo");
  assert.equal(relativeTime(ago(365 * d), now), "1y");
});

test("a missing, unparseable or future time is handled", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(relativeTime(null, now), "");
  assert.equal(relativeTime("", now), "");
  assert.equal(relativeTime("not a date", now), "");
  assert.equal(relativeTime("2026-10-07T12:05:00Z", now), "now");
});

test("a workspace's + opens /new on that repository or folder, the same URL each time", () => {
  assert.equal(newSessionHref({ kind: "cloud", projectId: "p1" }), "/new?project=p1");
  // A folder path is encoded, spaces and all.
  assert.equal(newSessionHref({ kind: "local", folder: "/Users/ada/my app" }), "/new?folder=%2FUsers%2Fada%2Fmy+app");
  // Stable, so it can be prefetched; the fresh form per click is startNewSession's.
  const start = { kind: "cloud", projectId: "p1" } as const;
  assert.equal(newSessionHref(start), newSessionHref(start));
});

test("a cloud session with work offers Archive; Delete only where there's nothing to archive", () => {
  const at = "2026-10-01T00:00:00Z";
  const statuses = ["ready", "idle", "suspended", "failed", "provisioning", "resuming"] as const;
  const sessions = [
    ...statuses.map((status, i) => ({ ...workspace(`w${i}`, "p1", at), createdAt: at, status })),
    // Still setting up an hour after it was made: its setup is never ending.
    { ...workspace("stalled", "p1", at), createdAt: "2026-09-30T23:00:00Z", status: "creating" as const },
    // A legacy sandbox has no Snapshot to restore from.
    { ...workspace("legacy", "p1", at), provider: "modal" as const },
  ];
  const [group] = buildSidebarGroups([project("p1", "outrunner")], sessions, [], {
    now: Date.parse("2026-10-01T00:01:00Z"),
  });
  const offered = Object.fromEntries(
    group.sessions.map((s) => [s.id, s.archivable ? "archive" : s.deletion ? "delete" : "none"]),
  );
  assert.deepEqual(
    [...statuses.map((status, i) => [status, offered[`w${i}`]]), ["stalled creating", offered.stalled], ["legacy", offered.legacy]],
    [
      ["ready", "archive"],
      ["idle", "archive"],
      ["suspended", "archive"],
      // It never started: there's no work for a Snapshot to keep.
      ["failed", "delete"],
      ["provisioning", "none"],
      ["resuming", "none"],
      ["stalled creating", "delete"],
      ["legacy", "delete"],
    ],
  );
});

test("deleting a local session removes its worktree, or only forgets an in-place one", () => {
  const [group] = buildSidebarGroups(
    [],
    [],
    [
      local("tree", "/Users/ada/app", "2026-10-01T00:00:00Z"),
      { ...local("here", "/Users/ada/app", "2026-10-02T00:00:00Z"), inPlace: true },
    ],
  );
  assert.deepEqual(
    group.sessions.map((s) => [s.id, s.deletion]),
    [
      ["here", { kind: "local-in-place" }],
      ["tree", { kind: "local-worktree" }],
    ],
  );
});

test("archived sessions, and ones being archived or deleted, leave the sidebar", () => {
  const at = "2026-10-01T00:00:00Z";
  const groups = buildSidebarGroups(
    [project("p1", "outrunner")],
    [
      { ...workspace("live", "p1", at), status: "ready" },
      { ...workspace("archiving", "p1", at), status: "archiving" },
      { ...workspace("shelved", "p1", at), status: "archived" },
      { ...workspace("going", "p1", at), status: "destroying" },
      { ...workspace("gone", "p1", at), status: "destroyed" },
    ],
    [],
  );
  assert.deepEqual(groups.flatMap((g) => g.sessions.map((s) => s.id)), ["live"]);
  // The server keeps no Snapshot of a session on this Mac: it is deleted.
  const [mac] = buildSidebarGroups([], [], [local("tree", "/Users/ada/app", at)]);
  assert.deepEqual([mac.sessions[0].archivable, mac.sessions[0].deletion], [false, { kind: "local-worktree" }]);
});

test("the delete confirmation says what goes and what stays", () => {
  assert.match(deletionConsequence({ kind: "cloud" }), /cloud computer.*GitHub stays/);
  assert.match(deletionConsequence({ kind: "local-worktree" }), /branch stays/);
  assert.match(deletionConsequence({ kind: "local-in-place" }), /untouched/);
});

test("a folded project shows only the session on screen, and every session while searching", () => {
  const [group] = buildSidebarGroups(
    [project("p1")],
    [
      workspace("w1", "p1", "2026-10-01T00:00:00Z"),
      workspace("w2", "p1", "2026-10-02T00:00:00Z"),
    ],
    [],
  );
  const ids = (options: Parameters<typeof shownSessions>[1]) => shownSessions(group, options).map((s) => s.id);
  assert.deepEqual(ids({ folded: false, searching: false, active: "w1" }), ["w2", "w1"]);
  assert.deepEqual(ids({ folded: true, searching: false, active: "w1" }), ["w1"]);
  assert.deepEqual(ids({ folded: true, searching: false, active: "elsewhere" }), []);
  assert.deepEqual(ids({ folded: true, searching: true }), ["w2", "w1"]);
});

test("folded projects round-trip through their cookie, the latest kept when there are too many", () => {
  const keys = ["cloud:p1", "local:/Users/me/a folder, with; odd \"chars\""];
  const value = foldedProjectsCookie(keys).split(";")[0].slice(`${FOLDED_PROJECTS_COOKIE}=`.length);
  assert.deepEqual(readFoldedProjects(value), keys);

  const many = Array.from({ length: 60 }, (_, i) => `cloud:p${i}`);
  const kept = readFoldedProjects(foldedProjectsCookie(many).split(";")[0].split("=")[1]);
  assert.equal(kept.length, 40);
  assert.equal(kept.at(-1), "cloud:p59");
});

test("a missing or garbled folded-projects cookie folds nothing", () => {
  assert.deepEqual(readFoldedProjects(undefined), []);
  assert.deepEqual(readFoldedProjects("%E0%A4%A"), []);
  assert.deepEqual(readFoldedProjects(encodeURIComponent('{"not":"a list"}')), []);
  assert.deepEqual(readFoldedProjects(encodeURIComponent('["cloud:p1", 7, null]')), ["cloud:p1"]);
});

test("while new local sessions are off, a Mac folder lists its sessions but starts none", () => {
  const [group] = buildSidebarGroups([], [], [local("a", "/Users/ada/app", "2026-10-01T00:00:00Z", "Write the README")]);
  assert.equal(group.start, null);
  assert.deepEqual(group.sessions.map((s) => s.href), ["/local/a"]);
});

test("deleted workspaces disappear from both sidebar groupings before the server list refreshes", () => {
  const at = "2026-10-01T00:00:00Z";
  const groups = buildSidebarGroups([project("p1")], [
    workspace("kept", "p1", at),
    { ...workspace("deleting", "p1", at), status: "destroying" },
    { ...workspace("deleted", "p1", at), status: "destroyed" },
  ], []);
  assert.deepEqual(groups.flatMap((group) => group.sessions.map((session) => session.id)), ["kept"]);
});

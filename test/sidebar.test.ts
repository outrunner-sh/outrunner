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
  newSessionHref,
  placeFor,
  readFoldedProjects,
  readSidebarPlace,
  relativeTime,
  shownSessions,
  sidebarSections,
} from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";

const project = (id: string, name = id): NavProject => ({ id, name, fullName: `acme/${name}` });

function workspace(id: string, projectId: string, at: string, title: string | null = null): Workspace {
  return {
    id,
    projectId,
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

test("the cloud's repositories come before this Mac's folders, each newest activity first", () => {
  const groups = buildSidebarGroups(
    [project("p1", "outrunner"), project("p2", "neev-ai")],
    [
      workspace("w1", "p1", "2026-10-01T00:00:00Z"),
      workspace("w2", "p2", "2026-10-05T00:00:00Z"),
    ],
    [
      local("l1", "/Users/ada/notes", "2026-10-03T00:00:00Z"),
      local("l2", "/Users/ada/site", "2026-10-09T00:00:00Z"),
    ],
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.local]),
    [
      ["neev-ai", false],
      ["outrunner", false],
      ["site", true],
      ["notes", true],
    ],
  );
});

test("the tabs split cloud from this Mac, a repository in both places on both", () => {
  const { cloud, local: mac } = sidebarSections(
    buildSidebarGroups(
      [project("p1", "outrunner")],
      [workspace("w1", "p1", "2026-10-01T00:00:00Z")],
      [local("l1", "/Users/ada/outrunner", "2026-10-03T00:00:00Z")],
    ),
  );
  assert.deepEqual(cloud.map((g) => [g.label, g.key]), [["outrunner", "cloud:p1"]]);
  assert.deepEqual(mac.map((g) => [g.label, g.key]), [["outrunner", "local:/Users/ada/outrunner"]]);
});

test("a search that only matches one place leaves the other tab empty", () => {
  const groups = buildSidebarGroups(
    [project("p1", "outrunner")],
    [workspace("w1", "p1", "2026-10-01T00:00:00Z", "Fix the login page")],
    [local("l1", "/Users/ada/notes", "2026-10-03T00:00:00Z", "Write the README")],
  );
  const { cloud, local: mac } = sidebarSections(filterSidebarGroups(groups, "readme"));
  assert.deepEqual(cloud, []);
  assert.deepEqual(mac.map((g) => g.label), ["notes"]);
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
    { id: "new", href: "/workspaces/new", title: "new", at: "2026-10-02T00:00:00Z", deletion: { kind: "cloud" } },
    {
      id: "old",
      href: "/workspaces/old",
      title: "Pull latest code from main",
      at: "2026-10-01T00:00:00Z",
      deletion: { kind: "cloud" },
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
  assert.deepEqual(buildSidebarGroups([project("p1")], [], []), []);
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

test("a session page opens on its own tab; any other page on the one last picked", () => {
  assert.equal(placeFor("/local/l1", "cloud"), "local");
  assert.equal(placeFor("/workspaces/w1", "local"), "cloud");
  assert.equal(placeFor("/new", "local"), "local");
  assert.equal(placeFor("/settings/general", "cloud"), "cloud");
  // Not a session page, only a path that starts like one.
  assert.equal(placeFor("/localhost", "cloud"), "cloud");
});

test("the tab cookie reads the cloud's for anything but this Mac's", () => {
  assert.equal(readSidebarPlace("local"), "local");
  assert.equal(readSidebarPlace("cloud"), "cloud");
  assert.equal(readSidebarPlace(undefined), "cloud");
  assert.equal(readSidebarPlace("mac"), "cloud");
});

test("a Mac session ranks by its last use, not by when it was made", () => {
  const groups = buildSidebarGroups(
    [],
    [],
    [
      // Made weeks ago, used today: above the folder made two days ago.
      local("l1", "/Users/ada/notes", "2026-09-01T00:00:00Z", "Notes", "2026-10-07T09:00:00Z"),
      local("l2", "/Users/ada/site", "2026-10-05T00:00:00Z"),
    ],
  );
  assert.deepEqual(groups.map((g) => g.label), ["notes", "site"]);
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
    [project("p1", "cloud-older"), project("p2", "cloud-newer")],
    [
      workspace("w1", "p1", "2026-10-07T11:59:59.999+00:00"),
      workspace("w2", "p2", "2026-10-07T12:00:00.001+00:00"),
    ],
    [
      local("l1", "/x/mac-older", "2026-10-07T12:00:00Z"),
      local("l2", "/x/mac-newer", "2026-10-07T12:00:00.001Z"),
    ],
  );
  assert.deepEqual(groups.map((g) => g.label), ["cloud-newer", "cloud-older", "mac-newer", "mac-older"]);
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

test("a workspace's + opens /new on that repository or folder, unique per click", () => {
  assert.equal(newSessionHref({ kind: "cloud", projectId: "p1" }, "a1"), "/new?project=p1&start=a1");
  // A folder path is encoded, spaces and all.
  assert.equal(
    newSessionHref({ kind: "local", folder: "/Users/ada/my app" }, "a2"),
    "/new?folder=%2FUsers%2Fada%2Fmy+app&start=a2",
  );
  // Two clicks on the same + differ, so the form is rebuilt even on the same target.
  const start = { kind: "cloud", projectId: "p1" } as const;
  assert.notEqual(newSessionHref(start, "x"), newSessionHref(start, "y"));
});

test("a cloud session can be deleted only from a settled status", () => {
  const at = "2026-10-01T00:00:00Z";
  const statuses = ["ready", "idle", "suspended", "archived", "failed", "provisioning", "destroying", "resuming"] as const;
  const [group] = buildSidebarGroups(
    [project("p1", "outrunner")],
    statuses.map((status, i) => ({ ...workspace(`w${i}`, "p1", at), status })),
    [],
  );
  const deletable = Object.fromEntries(group.sessions.map((s) => [s.id, s.deletion !== null]));
  assert.deepEqual(
    statuses.map((status, i) => [status, deletable[`w${i}`]]),
    [
      ["ready", true],
      ["idle", true],
      ["suspended", true],
      ["archived", true],
      ["failed", true],
      ["provisioning", false],
      ["destroying", false],
      ["resuming", false],
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

test("the delete confirmation says what goes and what stays", () => {
  assert.match(deletionConsequence({ kind: "cloud" }), /Runtime Computer.*GitHub stays/);
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

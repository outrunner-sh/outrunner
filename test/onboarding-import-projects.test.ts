import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVE_FOR_MS, importProjects, projectSources, shownSessions } from "@/lib/onboarding/import-projects";
import type { ImportScan, ScannedSession } from "@/lib/runtime/import-scan";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const DAY = 86_400_000;

function session(id: string, extra: Partial<ScannedSession> = {}): ScannedSession {
  return {
    key: `claude:${id}`,
    source: "claude-cli",
    agent: "claude",
    sessionId: id,
    title: id,
    cwd: "/r",
    repo: "ada/app",
    branch: `ada/${id}`,
    checkedOut: true,
    dirty: false,
    unpushed: 0,
    transcript: "/t",
    transcriptBytes: 1,
    updatedAt: new Date(NOW - DAY).toISOString(),
    ...extra,
  };
}

function scan(sessions: ScannedSession[]): ImportScan {
  return {
    version: 1,
    scannedAt: new Date(NOW).toISOString(),
    sources: [],
    sessions,
    projects: [],
    config: { items: [], mcpServers: [], plugins: [] },
  };
}

const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const keys = (list: ScannedSession[]) => list.map((s) => s.sessionId);

test("sessions group by repository in any case, the most recently worked in project first", () => {
  const projects = importProjects(
    scan([
      session("a1", { repo: "ada/app", updatedAt: ago(5) }),
      session("b1", { repo: "ada/blog", updatedAt: ago(1) }),
      session("a2", { repo: "Ada/App", updatedAt: ago(2) }),
    ]),
    NOW,
  );
  assert.deepEqual(
    projects.map((p) => [p.repo, keys(p.active)]),
    [
      ["ada/blog", ["b1"]],
      // Named as its newest session has it; its sessions newest first.
      ["Ada/App", ["a2", "a1"]],
    ],
  );
});

test("a session is active within 30 days; older ones, or ones with no time, wait to be asked for", () => {
  const [project] = importProjects(
    scan([
      session("edge", { updatedAt: new Date(NOW - ACTIVE_FOR_MS).toISOString() }),
      session("old", { updatedAt: ago(31) }),
      session("started", { updatedAt: undefined, startedAt: ago(3) }),
      session("timeless", { updatedAt: undefined }),
    ]),
    NOW,
  );
  assert.deepEqual(keys(project.active), ["started", "edge"]);
  assert.deepEqual(keys(project.older), ["old", "timeless"]);
  assert.deepEqual(keys(shownSessions(project, false)), ["started", "edge"]);
  assert.deepEqual(keys(shownSessions(project, true)), ["started", "edge", "old", "timeless"]);
});

test("only what can be imported is offered: no skip, a repository and branch, not archived in Conductor", () => {
  const projects = importProjects(
    scan([
      session("ok"),
      session("skipped", { skip: { reason: "no-github-remote" } }),
      session("no-repo", { repo: undefined }),
      session("no-branch", { branch: undefined }),
      session("archived", { source: "conductor", conductorState: "archived" }),
    ]),
    NOW,
  );
  assert.deepEqual(projects.map((p) => keys(p.active)), [["ok"]]);
  // Nothing to offer: no scan, or nothing in it that can move.
  assert.deepEqual(importProjects(null, NOW), []);
  assert.deepEqual(importProjects(scan([session("x", { skip: { reason: "too-large" } })]), NOW), []);
});

test("a project's sources are named once each, in the scan's own order", () => {
  assert.deepEqual(
    projectSources([
      session("1", { source: "codex-cli" }),
      session("2", { source: "conductor" }),
      session("3", { source: "codex-cli" }),
    ]),
    ["conductor", "codex-cli"],
  );
});

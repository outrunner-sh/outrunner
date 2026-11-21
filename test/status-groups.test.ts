import assert from "node:assert/strict";
import { test } from "node:test";

import type { SidebarGroup, SidebarSession } from "@/lib/nav/sidebar";
import { buildStatusSections, fallbackStanding, readGrouping, SECTION_SHOWN, shownRows } from "@/lib/nav/status-groups";
import { ATTENTION_AFTER_MS, type SessionStanding } from "@/lib/session/standing";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const session = (id: string, minutesAgo: number): SidebarSession => ({
  id,
  href: `/workspaces/${id}`,
  title: id,
  branch: `runtime/${id}`,
  at: ago(minutesAgo * 60_000),
  archivable: true,
  deletion: null,
});
const group = (key: string, sessions: SidebarSession[], local = false): SidebarGroup => ({
  key,
  label: key,
  detail: key,
  local,
  start: null,
  sessions,
});
const placed = (standing: SessionStanding["standing"], patch: Partial<SessionStanding> = {}): SessionStanding => ({
  standing,
  reason: null,
  moved: false,
  idle: standing !== "working",
  pinned: false,
  unread: false,
  replyPreview: null,
  at: ago(60 * 60_000),
  ...patch,
});

test("sessions are grouped by where they stand, pinned first, in the groups' order, empty ones left out", () => {
  const sections = buildStatusSections(
    [group("api", [session("a", 1), session("b", 2)]), group("web", [session("c", 3), session("d", 4)])],
    { a: placed("done"), b: placed("needs_you"), c: placed("working", { pinned: true }), d: placed("needs_you") },
    NOW,
  );
  assert.deepEqual(
    sections.map((s) => [s.key, s.rows.map((r) => r.id)]),
    [
      ["pinned", ["c"]],
      ["needs_you", ["b", "d"]],
      ["done", ["a"]],
    ],
  );
  assert.equal(sections[1].rows[0].project, "api");
});

test("a session without a server standing needs you until a pull request is known", () => {
  const sections = buildStatusSections([group("~/code", [session("m", 1), session("old", ATTENTION_AFTER_MS / 60_000 + 1)], true)], {}, NOW);
  assert.deepEqual(
    sections.map((s) => [s.key, s.rows.map((r) => r.id)]),
    [
      ["needs_you", ["m", "old"]],
    ],
  );
  assert.equal(sections[0].rows[0].markable, false, "a Mac session has no marks on the server");
  assert.equal(fallbackStanding("not a date", NOW).standing, "needs_you");
});

test("a section shows its first few, keeps the one on screen, and shows all while searching", () => {
  const many = Array.from({ length: SECTION_SHOWN + 3 }, (_, i) => session(`s${i}`, i));
  const standings = Object.fromEntries(many.map((s) => [s.id, placed("needs_you")]));
  const [section] = buildStatusSections([group("api", many)], standings, NOW);
  const closed = shownRows(section, { folded: false, expanded: false, searching: false });
  assert.equal(closed.rows.length, SECTION_SHOWN);
  assert.equal(closed.hidden, 3);
  const withActive = shownRows(section, { folded: false, expanded: false, searching: false, active: `s${SECTION_SHOWN + 2}` });
  assert.equal(withActive.rows.at(-1)?.id, `s${SECTION_SHOWN + 2}`);
  assert.equal(withActive.hidden, 2);
  assert.equal(shownRows(section, { folded: true, expanded: false, searching: false, active: "s1" }).rows.length, 1);
  assert.equal(shownRows(section, { folded: true, expanded: false, searching: true }).rows.length, many.length);
});

test("the grouping cookie reads status unless it says projects", () => {
  assert.equal(readGrouping(undefined), "status");
  assert.equal(readGrouping("projects"), "projects");
  assert.equal(readGrouping("nonsense"), "status");
});


test("open pull requests have their own In review section before Done", () => {
  const sections = buildStatusSections(
    [group("api", [session("review", 1), session("merged", 2)])],
    { review: placed("in_review"), merged: placed("done") },
    NOW,
  );
  assert.deepEqual(sections.map((section) => [section.key, section.label]), [["in_review", "In review"], ["done", "Done"]]);
});

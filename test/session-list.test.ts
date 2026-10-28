import assert from "node:assert/strict";
import { test } from "node:test";

import { filterSessions, NO_FILTER, othersStanding, ownerChoices, type SessionListEntry } from "@/lib/session/session-list";
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

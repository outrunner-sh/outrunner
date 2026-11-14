import assert from "node:assert/strict";
import { test } from "node:test";

import type { Workspace } from "@/lib/runtime/types";
import { ARCHIVED_UNSAVED } from "@/lib/session/archive-notice";
import { archivedSessions, searchArchived } from "@/lib/session/archived-sessions";

const row = (id: string, patch: Partial<Workspace>): Workspace =>
  ({
    id,
    projectId: "p1",
    status: "archived",
    branch: `runtime/${id}`,
    title: id,
    errorMessage: null,
    updatedAt: "2026-11-01T00:00:00Z",
    ...patch,
  }) as Workspace;

test("archived sessions list newest archived first, leaving out live ones and Missions", () => {
  const listed = archivedSessions(
    [
      row("older", { updatedAt: "2026-11-01T00:00:00Z" }),
      row("newer", { updatedAt: "2026-11-03T00:00:00Z" }),
      row("going", { status: "archiving", updatedAt: "2026-11-02T00:00:00Z" }),
      row("live", { status: "ready" }),
      row("mission", { kind: "mission" }),
      row("ship", { parentMissionId: "mission" }),
    ],
    [{ id: "p1", fullName: "acme/app" }],
  );
  assert.deepEqual(
    listed.map((s) => [s.id, s.archiving, s.project]),
    [
      ["newer", false, "acme/app"],
      ["going", true, "acme/app"],
      ["older", false, "acme/app"],
    ],
  );
});

test("one archived without its files says it can't be viewed or restored", () => {
  const [unsaved, saved] = archivedSessions(
    [
      row("unsaved", { errorMessage: ARCHIVED_UNSAVED, updatedAt: "2026-11-02T00:00:00Z" }),
      row("saved", {}),
    ],
    [],
  );
  assert.deepEqual([unsaved.saved, saved.saved, saved.project], [false, true, ""]);
});

test("search matches title, repository or branch, ignoring case", () => {
  const listed = archivedSessions(
    [row("fix-login", { title: "Fix login" }), row("docs", { title: "Docs", branch: "runtime/readme" })],
    [{ id: "p1", fullName: "acme/app" }],
  );
  assert.deepEqual(searchArchived(listed, "LOGIN").map((s) => s.id), ["fix-login"]);
  assert.deepEqual(searchArchived(listed, "readme").map((s) => s.id), ["docs"]);
  assert.equal(searchArchived(listed, "acme").length, 2);
  assert.equal(searchArchived(listed, "  ").length, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalSession } from "@/lib/desktop/local-runtime";
import { groupLocalSessions, localSessionLabel } from "@/lib/desktop/local-sessions";

function session(id: string, folder: string, extra: Partial<LocalSession> = {}): LocalSession {
  const name = folder.split("/").filter(Boolean).at(-1) ?? folder;
  return {
    workspaceId: id,
    name,
    title: `task ${id}`,
    folder,
    worktree: `/Users/ada/.outrunner/workspaces/${id}`,
    branch: `runtime/${id}`,
    baseBranch: "main",
    inPlace: false,
    createdAt: "2026-10-06T00:00:00Z",
    running: false,
    ...extra,
  };
}

test("sessions sit under their folder, folders in order of their newest session", () => {
  // The agent lists newest first.
  const groups = groupLocalSessions([
    session("c", "/Users/ada/code/app"),
    session("b", "/Users/ada/notes"),
    session("a", "/Users/ada/code/app"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.sessions.map((s) => s.workspaceId)]),
    [
      ["app", ["c", "a"]],
      ["notes", ["b"]],
    ],
  );
  assert.equal(groups[0].folder, "/Users/ada/code/app");
});

test("two folders with the same name are told apart by their parent", () => {
  const groups = groupLocalSessions([
    session("a", "/Users/ada/work/app"),
    session("b", "/Users/ada/personal/app"),
    session("c", "/Users/ada/notes"),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ["work/app", "personal/app", "notes"]);
});

test("same-named parents are told apart by going further up", () => {
  const groups = groupLocalSessions([
    session("a", "/work/project/app"),
    session("b", "/personal/project/app"),
    session("c", "/personal/other/app"),
    session("d", "/app"),
  ]);
  assert.deepEqual(groups.map((g) => g.label), [
    "work/project/app",
    "personal/project/app",
    "other/app",
    "/app",
  ]);
});

test("a session is labelled by what was asked, else its branch", () => {
  assert.equal(localSessionLabel(session("a", "/x/app")), "task a");
  // Recorded before sessions had titles: the branch says more than repeating
  // the folder name it is already grouped under.
  assert.equal(localSessionLabel(session("b", "/x/no -video ", { title: "" })), "b");
});

test("folder names keep their exact spelling", () => {
  // A real folder on the Mac this was built on ends in a space.
  assert.equal(groupLocalSessions([session("a", "/Users/ada/no -video ")])[0].label, "no -video ");
});

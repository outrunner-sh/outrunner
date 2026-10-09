import assert from "node:assert/strict";
import { test } from "node:test";

import { newSessionDetails } from "@/lib/session/new-session-target";

const folder = { path: "/Users/ada/app", name: "app", git: true, branch: "main" };

test("a cloud repository starts on its default branch, in a new worktree", () => {
  const details = newSessionDetails({ kind: "cloud", project: { defaultBranch: "trunk" } });
  assert.equal(details.branch, "trunk");
  assert.equal(details.worktree?.label, "New worktree");
  assert.match(details.worktree?.title ?? "", /off trunk/);
});

test("no repository chosen names no branch and no worktree", () => {
  assert.deepEqual(newSessionDetails({ kind: "cloud", project: undefined }), {
    branch: null,
    worktree: null,
  });
});

test("a git folder starts on its checked-out branch, in a new worktree", () => {
  const details = newSessionDetails({ kind: "local", folder });
  assert.equal(details.branch, "main");
  assert.equal(details.worktree?.label, "New worktree");
  assert.match(details.worktree?.title ?? "", /off main/);
});

test("a git folder with a detached HEAD names HEAD", () => {
  const details = newSessionDetails({ kind: "local", folder: { ...folder, branch: null } });
  assert.equal(details.branch, "HEAD");
  assert.match(details.worktree?.title ?? "", /off HEAD/);
});

test("a folder that is not a repository has no branch and is edited in place", () => {
  const details = newSessionDetails({ kind: "local", folder: { ...folder, git: false, branch: null } });
  assert.equal(details.branch, null);
  assert.equal(details.worktree?.label, "No worktree");
  assert.match(details.worktree?.title ?? "", /in place/);
});

test("no folder chosen (or still being checked) names no branch and no worktree", () => {
  assert.deepEqual(newSessionDetails({ kind: "local", folder: null }), { branch: null, worktree: null });
});

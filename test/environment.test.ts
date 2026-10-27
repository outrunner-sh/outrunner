import assert from "node:assert/strict";
import { test } from "node:test";

import { changeTotals, environmentSummary } from "@/lib/session/environment";

test("change totals sum every file's additions and deletions", () => {
  assert.deepEqual(
    changeTotals([
      { additions: 3, deletions: 1 },
      { additions: 1, deletions: 0 },
      { additions: 0, deletions: 7 },
    ]),
    { files: 3, additions: 4, deletions: 8 },
  );
});

test("no changed files total to zero", () => {
  assert.deepEqual(changeTotals([]), { files: 0, additions: 0, deletions: 0 });
});

const cloud = { provider: "daytona" as const, branch: "runtime/abc", baseBranch: "main", worktreePath: "/work/abc" };

test("a cloud session works on its branch, in its worktree", () => {
  assert.deepEqual(environmentSummary(cloud), {
    branch: "runtime/abc",
    baseBranch: "main",
    workingPath: "/work/abc",
  });
});

test("a cloud session with no branch yet names no branch and no base", () => {
  const summary = environmentSummary({ ...cloud, branch: "" });
  assert.equal(summary.branch, null);
  assert.equal(summary.baseBranch, null);
});

test("a cloud session with no worktree path recorded names none", () => {
  assert.equal(environmentSummary({ ...cloud, worktreePath: "" }).workingPath, null);
});

const local = {
  name: "app",
  folder: "/Users/ada/app",
  worktree: "/Users/ada/.outrunner/workspaces/xyz",
  branch: "runtime/xyz",
  baseBranch: "main",
  inPlace: false,
};

test("a local session in a worktree works on its own branch, in its worktree", () => {
  assert.deepEqual(environmentSummary(cloud, local), {
    branch: "runtime/xyz",
    baseBranch: "main",
    workingPath: "/Users/ada/.outrunner/workspaces/xyz",
  });
});

test("a local session editing its folder in place has no branch and works in the folder", () => {
  const summary = environmentSummary(cloud, { ...local, inPlace: true });
  assert.equal(summary.branch, null);
  assert.equal(summary.baseBranch, null);
  assert.equal(summary.workingPath, "/Users/ada/app");
});

test("a local worktree with no recorded base names no base", () => {
  assert.equal(environmentSummary(cloud, { ...local, baseBranch: "" }).baseBranch, null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { prInstructions } from "@/lib/session/pr-instructions";

test("the instructions name the branch, its target and what's uncommitted", () => {
  const md = prInstructions({ branch: "runtime/abc", baseBranch: "develop", uncommitted: 3 });
  assert.match(md, /^There are 3 uncommitted changes\.$/m);
  assert.match(md, /^The current branch is runtime\/abc\.$/m);
  assert.match(md, /^The target branch is origin\/develop\.$/m);
  assert.match(md, /`git push -u origin runtime\/abc`/);
  assert.match(md, /`git diff origin\/develop\.\.\.`/);
  assert.match(md, /`gh pr create --base develop`/);
});

test("one uncommitted change is singular, none says so", () => {
  assert.match(prInstructions({ branch: "b", baseBranch: "main", uncommitted: 1 }), /^There is 1 uncommitted change\.$/m);
  assert.match(prInstructions({ branch: "b", baseBranch: "main", uncommitted: 0 }), /^There are no uncommitted changes\.$/m);
});

test("an unknown count is left out rather than guessed", () => {
  const md = prInstructions({ branch: "b", baseBranch: "main", uncommitted: null });
  assert.doesNotMatch(md, /^There (is|are) .*uncommitted/m);
  assert.match(md, /^The current branch is b\.$/m);
});

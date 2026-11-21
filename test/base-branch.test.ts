import assert from "node:assert/strict";
import { test } from "node:test";

import { baseBranchChoices } from "@/lib/session/base-branch";

test("the default branch comes first, then the rest by name", () => {
  const choices = baseBranchChoices({ branches: ["develop", "main", "release/1.2"], total: 3 }, "main", "");
  assert.deepEqual(choices, { branches: ["main", "develop", "release/1.2"], complete: true });
});

test("the default branch is offered even when GitHub's first page left it out", () => {
  const choices = baseBranchChoices({ branches: ["a", "b"], total: 300 }, "trunk", "");
  assert.deepEqual(choices.branches, ["trunk", "a", "b"]);
  assert.equal(choices.complete, false);
});

test("a search shows the default branch only when it matches", () => {
  assert.deepEqual(baseBranchChoices({ branches: ["release/1.2"], total: 1 }, "main", "release").branches, ["release/1.2"]);
  assert.deepEqual(baseBranchChoices({ branches: ["main", "maintenance"], total: 2 }, "main", "MAIN").branches, ["main", "maintenance"]);
});

test("with no token, the default branch alone", () => {
  assert.deepEqual(baseBranchChoices({ branches: [], total: 0 }, "main", ""), { branches: ["main"], complete: true });
});

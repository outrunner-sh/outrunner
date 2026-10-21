import assert from "node:assert/strict";
import { test } from "node:test";

import { activeIndexOf, stepIndex } from "@/lib/nav/active-option";

const key = (repo: { id: number }) => repo.id;

test("the active option is followed by its key when the list changes under it", () => {
  const before = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(activeIndexOf(before, key, 3), 2);
  // A Refresh re-sorts the list: still repo 3, now first.
  assert.equal(activeIndexOf([{ id: 3 }, { id: 1 }], key, 3), 0);
  // Gone, or nothing chosen yet: the first, never past the end.
  assert.equal(activeIndexOf([{ id: 1 }], key, 3), 0);
  assert.equal(activeIndexOf(before, key, null), 0);
  assert.equal(activeIndexOf([], key, 3), -1);
});

test("arrow keys wrap round the list", () => {
  assert.equal(stepIndex(3, 2, 1), 0);
  assert.equal(stepIndex(3, 0, -1), 2);
  assert.equal(stepIndex(3, 1, 1), 2);
  assert.equal(stepIndex(0, 0, 1), -1);
});

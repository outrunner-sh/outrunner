import assert from "node:assert/strict";
import { test } from "node:test";

import { isUuid } from "../lib/ids.ts";

test("isUuid accepts a row id in either case", () => {
  assert.equal(isUuid("3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b"), true);
  assert.equal(isUuid("3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B"), true);
});

test("isUuid rejects what a stale or mistyped link holds", () => {
  for (const value of ["", "abc", "123", "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0", "3f2b8c1e9a4d4e6f8b2a1c3d5e7f9a0b", "../etc/passwd"]) {
    assert.equal(isUuid(value), false, value);
  }
});

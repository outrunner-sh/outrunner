import assert from "node:assert/strict";
import { test } from "node:test";

import { newestFirst } from "@/lib/nav/workspace-nav-groups";

test("newestFirst orders by instant across the formats we receive", () => {
  const times = [
    "2026-10-07T12:00:00Z",
    "2026-10-07T12:00:00.001+00:00",
    "2026-10-07T13:30:00+01:30", // the same instant as 12:00Z
    "2026-10-07T11:59:59.999Z",
  ];
  const sorted = times.slice().sort(newestFirst);
  assert.equal(sorted[0], "2026-10-07T12:00:00.001+00:00");
  assert.equal(sorted[3], "2026-10-07T11:59:59.999Z");
});

test("equal instants compare equal; missing or bad times sort last", () => {
  assert.equal(newestFirst("2026-10-07T12:00:00Z", "2026-10-07T12:00:00.000+00:00"), 0);
  assert.equal(newestFirst(null, undefined), 0);
  assert.deepEqual(
    ["", "2026-01-01T00:00:00Z", "nope", null].sort(newestFirst),
    ["2026-01-01T00:00:00Z", "", "nope", null],
  );
});

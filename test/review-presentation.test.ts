import assert from "node:assert/strict";
import { test } from "node:test";

import { compactCount, totalLines } from "@/lib/review/presentation";

test("unread counts remain distinct from a PR with zero changes", () => {
  assert.equal(totalLines(null), null);
  assert.deepEqual(
    totalLines({
      code: { additions: 0, deletions: 0 },
      test: { additions: 0, deletions: 0 },
      generated: { additions: 0, deletions: 0 },
    }),
    { additions: 0, deletions: 0 },
  );
});

test("compact inbox totals include code, tests and generated files without changing their breakdown", () => {
  const counts = Object.freeze({
    code: { additions: 21, deletions: 3 },
    test: { additions: 90, deletions: 10 },
    generated: { additions: 1000, deletions: 400 },
  });
  assert.deepEqual(totalLines(counts), { additions: 1111, deletions: 413 });
  assert.deepEqual(counts.generated, { additions: 1000, deletions: 400 });
});

test("change counts stay precise for small PRs and readable for large ones", () => {
  assert.equal(compactCount(0), "0");
  assert.equal(compactCount(999), "999");
  assert.equal(compactCount(2534), "2.5K");
  assert.equal(compactCount(1250000), "1.3M");
});

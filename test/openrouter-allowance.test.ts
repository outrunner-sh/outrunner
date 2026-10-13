import assert from "node:assert/strict";
import { test } from "node:test";

import { allowanceView } from "@/lib/openrouter/allowance";

test("the bar shows what's spent of the $5", () => {
  assert.deepEqual(allowanceView({ usedUsd: 0, limitUsd: 5 }), {
    state: "ok",
    percent: 0,
    label: "$0 of $5 used",
    limit: "$5",
  });
  const some = allowanceView({ usedUsd: 1.2, limitUsd: 5 });
  assert.equal(some.state, "ok");
  assert.equal(Math.round(some.percent), 24);
  assert.equal(some.label, "$1.20 of $5 used");
});

test("from 80% it warns, and spent (to within half a cent) it's out", () => {
  assert.equal(allowanceView({ usedUsd: 4, limitUsd: 5 }).state, "low");
  assert.equal(allowanceView({ usedUsd: 4.996, limitUsd: 5 }).state, "out");
  const out = allowanceView({ usedUsd: 5, limitUsd: 5 });
  assert.equal(out.state, "out");
  assert.equal(out.percent, 100);
  assert.equal(out.label, "$5 of $5 used");
});

test("an overspend or a bad number never breaks the bar", () => {
  const over = allowanceView({ usedUsd: 5.31, limitUsd: 5 });
  assert.equal(over.percent, 100);
  assert.equal(over.label, "$5 of $5 used");
  assert.equal(allowanceView({ usedUsd: -1, limitUsd: 5 }).percent, 0);
  assert.equal(allowanceView({ usedUsd: 0, limitUsd: 0 }).state, "out");
});

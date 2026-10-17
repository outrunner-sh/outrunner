import assert from "node:assert/strict";
import { test } from "node:test";

import { allowanceView } from "@/lib/openrouter/allowance";

test("the bar shows what's used as a percentage, never dollars", () => {
  assert.deepEqual(allowanceView({ usedUsd: 0, limitUsd: 5 }), { state: "ok", percent: 0, label: "0% used" });
  const some = allowanceView({ usedUsd: 1.2, limitUsd: 5 });
  assert.equal(some.state, "ok");
  assert.equal(Math.round(some.percent), 24);
  assert.equal(some.label, "24% used");
  for (const usedUsd of [0, 1.2, 4, 5, 7]) {
    assert.doesNotMatch(JSON.stringify(allowanceView({ usedUsd, limitUsd: 5 })), /\$/);
  }
});

test("a little is <1%, and nearly all isn't rounded up to 100% while some is left", () => {
  assert.equal(allowanceView({ usedUsd: 0.01, limitUsd: 5 }).label, "<1% used");
  const nearly = allowanceView({ usedUsd: 4.98, limitUsd: 5 });
  assert.equal(nearly.state, "low");
  assert.equal(nearly.label, "99% used");
});

test("from 80% it warns, and spent (to within half a cent) it's out", () => {
  assert.equal(allowanceView({ usedUsd: 4, limitUsd: 5 }).state, "low");
  assert.equal(allowanceView({ usedUsd: 4.996, limitUsd: 5 }).state, "out");
  const out = allowanceView({ usedUsd: 5, limitUsd: 5 });
  assert.equal(out.state, "out");
  assert.equal(out.percent, 100);
  assert.equal(out.label, "100% used");
});

test("an overspend or a bad number never breaks the bar", () => {
  const over = allowanceView({ usedUsd: 5.31, limitUsd: 5 });
  assert.equal(over.percent, 100);
  assert.equal(over.label, "100% used");
  assert.equal(allowanceView({ usedUsd: -1, limitUsd: 5 }).percent, 0);
  assert.equal(allowanceView({ usedUsd: 0, limitUsd: 0 }).state, "out");
});

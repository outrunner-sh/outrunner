import assert from "node:assert/strict";
import { test } from "node:test";

import { ORG_TINTS, orgInitial, orgSummary, orgTint } from "@/lib/orgs/badge";

test("an org's mark is its name's first letter, an emoji whole", () => {
  assert.equal(orgInitial("neev ai"), "N");
  assert.equal(orgInitial("  zerotrail"), "Z");
  assert.equal(orgInitial("🚀 rockets"), "🚀");
  assert.equal(orgInitial(""), "?");
});

test("an org keeps its tint, and the tints spread across orgs", () => {
  assert.equal(orgTint("org-1"), orgTint("org-1"));
  const used = new Set(Array.from({ length: 40 }, (_, i) => orgTint(`9f1c${i}-uuid`)));
  assert.ok(used.size > ORG_TINTS.length / 2);
});

test("the switcher says whose an org is, and the user's part in a team's", () => {
  assert.equal(orgSummary({ personal: true, role: "admin" }), "Personal");
  assert.equal(orgSummary({ personal: false, role: "admin" }), "Team · Admin");
  assert.equal(orgSummary({ personal: false, role: "member" }), "Team · Member");
});

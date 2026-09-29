import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAllowlist } from "@/lib/auth/allowlist";

test("parseAllowlist accepts a single login", () => {
  const set = parseAllowlist("octocat");
  assert.deepEqual([...set], ["octocat"]);
});

test("parseAllowlist splits a comma-separated team and lowercases", () => {
  const set = parseAllowlist("Octocat, Alice ,BOB");
  assert.equal(set.has("octocat"), true);
  assert.equal(set.has("alice"), true);
  assert.equal(set.has("bob"), true);
  assert.equal(set.size, 3);
});

test("parseAllowlist tolerates whitespace/newline separators and blanks", () => {
  const set = parseAllowlist("  you \n teammate ,, ");
  assert.deepEqual([...set].sort(), ["teammate", "you"]);
});

test("parseAllowlist yields an empty set for blank/undefined (rejects everyone)", () => {
  assert.equal(parseAllowlist("").size, 0);
  assert.equal(parseAllowlist("   ").size, 0);
  assert.equal(parseAllowlist(undefined).size, 0);
});

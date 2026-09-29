import assert from "node:assert/strict";
import { test } from "node:test";

import { last4FromHint } from "@/lib/runtime/credentials/mask";

/**
 * PR #18's version of this file exercised an injected fake database against its
 * own `user_claude_credentials` table. That table and its injection seam are
 * gone — the adapter now writes to the single `user_credentials` row the
 * workspace gate reads — so those cases moved to the store itself. What is left
 * here is the one decision this module still makes.
 */
test("a stored hint is masked down to its last four characters", () => {
  assert.equal(last4FromHint("sk-…AbCd"), "AbCd");
});

test("no stored credential means no hint to show", () => {
  assert.equal(last4FromHint(null), null);
});

test("an empty hint does not render as an empty badge", () => {
  assert.equal(last4FromHint(""), null);
});

test("a hint shorter than four characters is dropped rather than padded", () => {
  // Better to show nothing than to imply a mask that isn't there.
  assert.equal(last4FromHint("ab"), null);
});

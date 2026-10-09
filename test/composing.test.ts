import assert from "node:assert/strict";
import { test } from "node:test";

import { isImeKeydown } from "@/lib/session/composing";

test("Enter that commits an input-method composition is not a send", () => {
  // Chrome: still composing when Enter arrives.
  assert.equal(isImeKeydown({ isComposing: true, keyCode: 229 }), true);
  // Safari and WKWebView: the composition already ended, keyCode 229 remains.
  assert.equal(isImeKeydown({ isComposing: false, keyCode: 229 }), true);
});

test("a plain Enter is the user's", () => {
  assert.equal(isImeKeydown({ isComposing: false, keyCode: 13 }), false);
});

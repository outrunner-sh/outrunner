import assert from "node:assert/strict";
import { test } from "node:test";

import { checkModalToken } from "@/lib/runtime/sandbox/modal-token";

const ID = "ak-AbCdEfGh1234567890XyZw";
const SECRET = "as-ZyXw0987654321hGfEdCbA";

test("a token's parts are checked one by one, so the error says which is wrong", () => {
  assert.deepEqual(checkModalToken({ tokenId: ` ${ID} `, tokenSecret: `${SECRET}\n` }), {
    token: { tokenId: ID, tokenSecret: SECRET },
  });
  assert.match(errorOf({ tokenId: SECRET, tokenSecret: ID }), /wrong way round/);
  assert.match(errorOf({ tokenId: "ak-short", tokenSecret: SECRET }), /token id/);
  assert.match(errorOf({ tokenId: ID, tokenSecret: SECRET.slice(0, 23) + "!" }), /token secret/);
  assert.match(errorOf({ tokenId: ID, tokenSecret: `--token-secret ${SECRET}` }), /token secret/);
  assert.match(errorOf(null), /token id/);
  assert.match(errorOf({ tokenId: 42, tokenSecret: SECRET }), /token id/);
});

function errorOf(value: unknown): string {
  const checked = checkModalToken(value);
  assert.ok("error" in checked, "expected the token to be refused");
  return checked.error;
}

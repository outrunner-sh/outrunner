import assert from "node:assert/strict";
import { test } from "node:test";

import { checkModalToken, modalTokenInText } from "@/lib/runtime/sandbox/modal-token";

const ID = "ak-AbCdEfGh1234567890XyZw";
const SECRET = "as-ZyXw0987654321hGfEdCbA";

test("Modal's copied `modal token set` command gives both parts", () => {
  assert.deepEqual(
    modalTokenInText(`modal token set --token-id ${ID} --token-secret ${SECRET} --profile=immadsahin\n`),
    { tokenId: ID, tokenSecret: SECRET },
  );
  assert.deepEqual(modalTokenInText(`$ modal token set --token-id=${ID} --token-secret=${SECRET}`), {
    tokenId: ID,
    tokenSecret: SECRET,
  });
});

test(".env lines give the parts they have", () => {
  assert.deepEqual(modalTokenInText(`MODAL_TOKEN_ID=${ID}\nMODAL_TOKEN_SECRET=${SECRET}`), {
    tokenId: ID,
    tokenSecret: SECRET,
  });
  assert.deepEqual(modalTokenInText(`MODAL_TOKEN_SECRET=${SECRET}`), { tokenSecret: SECRET });
});

test("a bare value, or one being typed, is left to its field", () => {
  for (const text of [ID, SECRET, `  ${SECRET}\n`, "as-", "a", ""]) assert.equal(modalTokenInText(text), null);
  // Text with no token in it isn't a paste to split.
  assert.equal(modalTokenInText("modal token set --profile=me"), null);
  // A flag name isn't a token: `--token-id` holds "-id", not "ak-…".
  assert.equal(modalTokenInText("task-runner bias-x"), null);
});

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

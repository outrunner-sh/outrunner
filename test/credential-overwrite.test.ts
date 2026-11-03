import assert from "node:assert/strict";
import { test } from "node:test";

import { githubTokenOverwrite } from "@/lib/db/credential-overwrite";

const same = (token: string) => (plaintext: string) => plaintext === token;
const foreign = { kind: "foreign", sealedWith: "aaaaaaaa", ours: "bbbbbbbb" } as const;

test("a token this server can read is replaced, or left when it's the same", () => {
  assert.deepEqual(githubTokenOverwrite(null, same("gho_new"), false), { kind: "write" });
  assert.deepEqual(githubTokenOverwrite({ kind: "opens", plaintext: "gho_old" }, same("gho_new"), false), { kind: "write" });
  assert.deepEqual(githubTokenOverwrite({ kind: "opens", plaintext: "gho_new" }, same("gho_new"), true), { kind: "unchanged" });
});

test("a local dev server never overwrites production's token it can't read", () => {
  // As on 11-01 and 11-03: a dev server on production's database, its own key.
  const refused = githubTokenOverwrite(foreign, same("gho_new"), false);
  assert.equal(refused.kind, "refuse");
  assert.match((refused as { reason: string }).reason, /fingerprint aaaaaaaa, ours bbbbbbbb.*local dev server/);
  assert.equal(githubTokenOverwrite({ kind: "unreadable" }, same("gho_new"), false).kind, "refuse");
});

test("production replaces a token another server sealed, saying so", () => {
  assert.equal(githubTokenOverwrite(foreign, same("gho_new"), true).kind, "replace");
  assert.equal(githubTokenOverwrite({ kind: "unreadable" }, same("gho_new"), true).kind, "replace");
});

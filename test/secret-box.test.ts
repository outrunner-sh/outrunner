import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import { open, sameSecret, seal } from "@/lib/crypto/secret-box";

const KEY_A = randomBytes(32).toString("base64url");
const KEY_B = randomBytes(32).toString("base64url");

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY_A;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = saved;
});

test("seal → open round-trips a credential", () => {
  const token = "ghp_exampleTokenValue000000000000000000";
  assert.equal(open(seal(token)), token);
});

test("seal never emits the plaintext", () => {
  const token = "sk-ant-secret-value";
  assert.ok(!seal(token).includes(token));
});

test("seal uses a fresh IV, so the same input yields different ciphertexts", () => {
  // IV reuse under GCM is catastrophic — two seals of one value must differ.
  assert.notEqual(seal("same"), seal("same"));
});

test("a key that is not 32 bytes is rejected with actionable guidance", () => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.from("too short").toString("base64url");
  assert.throws(() => seal("x"), /must decode to 32 bytes/);
});

test("a hex-encoded key works as well as base64url", () => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.equal(open(seal("hex-keyed")), "hex-keyed");
});

test("open rejects a tampered ciphertext rather than returning garbage", () => {
  const sealed = seal("authentic");
  const [v, iv, tag, ct] = sealed.split(".");
  // Flip the final ciphertext byte; GCM's tag check must catch it.
  const bytes = Buffer.from(ct, "base64url");
  bytes[bytes.length - 1] ^= 0xff;
  assert.throws(() => open([v, iv, tag, bytes.toString("base64url")].join(".")));
});

test("open rejects a value sealed under a different key", () => {
  const sealed = seal("cross-key");
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY_B;
  assert.throws(() => open(sealed));
});

test("open rejects malformed and wrong-version values", () => {
  assert.throws(() => open("not-sealed"), /Malformed/);
  assert.throws(() => open("v2.a.b.c"), /Malformed/);
  assert.throws(() => open(seal("x").replace(/^v1\./, "v9.")), /Malformed/);
});

test("open rejects a truncated IV", () => {
  const [v, , tag, ct] = seal("x").split(".");
  const shortIv = randomBytes(8).toString("base64url");
  assert.throws(() => open([v, shortIv, tag, ct].join(".")), /bad IV length/);
});

test("sameSecret compares by value and tolerates length mismatch", () => {
  assert.ok(sameSecret("abc", "abc"));
  assert.ok(!sameSecret("abc", "abd"));
  assert.ok(!sameSecret("abc", "abcd"));
  assert.ok(!sameSecret("", "x"));
});

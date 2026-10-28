import assert from "node:assert/strict";
import { test } from "node:test";

import { apiCredential, hashApiKey, keyExpiry, keyHint, keyName, keyUsable, newApiKey } from "@/lib/api/keys";

const auth = (value: string) => new Headers({ authorization: value });

test("a new key has its own prefix, and is told apart from a CLI token", () => {
  const key = newApiKey();
  assert.match(key, /^or_key_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(apiCredential(auth(`Bearer ${key}`)), { kind: "api_key", secret: key });
  const cli = `or_cli_${"a".repeat(43)}`;
  assert.deepEqual(apiCredential(auth(`Bearer ${cli}`)), { kind: "cli_token", secret: cli });
});

test("anything else in the header is no credential", () => {
  assert.equal(apiCredential(new Headers()), null);
  assert.equal(apiCredential(auth("Bearer or_key_short")), null);
  assert.equal(apiCredential(auth(`Basic or_key_${"a".repeat(43)}`)), null);
  assert.equal(apiCredential(auth(`Bearer sk-${"a".repeat(43)}`)), null);
});

test("only the hash is stored, and the hint is the last four characters", () => {
  const key = newApiKey();
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
  assert.notEqual(hashApiKey(key), key);
  assert.equal(keyHint(key), key.slice(-4));
});

test("a key's name is trimmed text of 1 to 80 characters", () => {
  assert.equal(keyName("  CI   deploy "), "CI deploy");
  assert.equal(keyName(""), null);
  assert.equal(keyName("x".repeat(81)), null);
  assert.equal(keyName(42), null);
});

test("a key lasts 1 to 365 days, or never expires", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  assert.equal(keyExpiry(undefined, now), null);
  assert.equal(keyExpiry(null, now), null);
  assert.equal(keyExpiry(30, now), "2026-12-01T00:00:00.000Z");
  assert.equal(keyExpiry("1", now), "2026-11-02T00:00:00.000Z");
  assert.equal(keyExpiry(0, now), undefined);
  assert.equal(keyExpiry(366, now), undefined);
  assert.equal(keyExpiry(1.5, now), undefined);
});

test("a revoked or expired key signs no one in", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  assert.equal(keyUsable({ revokedAt: null, expiresAt: null }, now), true);
  assert.equal(keyUsable({ revokedAt: "2026-10-01T00:00:00Z", expiresAt: null }, now), false);
  assert.equal(keyUsable({ revokedAt: null, expiresAt: "2026-10-31T23:59:59Z" }, now), false);
  assert.equal(keyUsable({ revokedAt: null, expiresAt: "2026-11-02T00:00:00Z" }, now), true);
});

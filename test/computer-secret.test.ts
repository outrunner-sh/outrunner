/** Runtime Computer secrets at rest (lib/db/computer-secret.ts): sealed like
 * user credentials, with the rows from before sealing still readable. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import { isSealed, open, seal } from "@/lib/crypto/secret-box";
import { openAgentSecretOrNull, storeAgentSecret } from "@/lib/db/computer-secret";

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

test("stored is sealed, and opens back to the secret", () => {
  const secret = randomBytes(32).toString("hex");
  const stored = storeAgentSecret(secret);
  assert.ok(isSealed(stored));
  assert.ok(!stored.includes(secret));
  assert.equal(openAgentSecretOrNull(stored, "c1"), secret);
});

test("a plaintext value from before sealing passes through untouched", () => {
  const legacy = randomBytes(32).toString("hex");
  assert.equal(openAgentSecretOrNull(legacy, "c1"), legacy);
});

test("absent is null", () => {
  assert.equal(openAgentSecretOrNull(null, "c1"), null);
  assert.equal(openAgentSecretOrNull(undefined, "c1"), null);
});

test("a secret sealed under a rotated key opens to null, not a throw", () => {
  const stored = storeAgentSecret(randomBytes(32).toString("hex"));
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY_B;
  assert.equal(openAgentSecretOrNull(stored, "c1"), null);
});

test("a tampered sealed value opens to null", () => {
  const stored = storeAgentSecret(randomBytes(32).toString("hex"));
  // A byte of the ciphertext flipped: editing its last base64url characters
  // could change only their unused padding bits, decoding to the same bytes.
  const [version, iv, tag, ciphertext] = stored.split(".");
  const bytes = Buffer.from(ciphertext, "base64url");
  bytes[0] ^= 0xff;
  const tampered = [version, iv, tag, bytes.toString("base64url")].join(".");
  assert.equal(openAgentSecretOrNull(tampered, "c1"), null);
});

test("an unopenable value never falls back to plaintext", () => {
  // The sealed prefix is what routes to open(); a value claiming it must not
  // pass through as if it were a legacy plaintext one.
  assert.equal(openAgentSecretOrNull("v1.not-really-sealed", "c1"), null);
});

test("a legacy value is not mistaken for sealed", () => {
  // A real hex secret never starts with the wire format's version prefix.
  assert.ok(!isSealed(randomBytes(32).toString("hex")));
  assert.equal(open(seal("s")), "s");
});

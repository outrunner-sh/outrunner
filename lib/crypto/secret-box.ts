/**
 * Authenticated encryption for third-party credentials at rest.
 *
 * `user_credentials` holds each user's GitHub and Anthropic credentials. RLS
 * already keeps that table service-role-only, but a database dump, a logged
 * query, or a leaked service-role key would otherwise hand over every user's
 * tokens in clear. Sealing them means an attacker needs the database AND
 * CREDENTIALS_ENCRYPTION_KEY (which lives in the app environment, not the DB).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to open rather
 * than decrypting to attacker-chosen bytes. A fresh random 96-bit IV per seal —
 * never reuse an IV with the same key under GCM; it is catastrophic, leaking
 * the keystream and the authentication key.
 *
 * Wire format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version
 * prefix exists so the algorithm or key derivation can change later without
 * ambiguity about how an existing row was written.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { requireEnv } from "@/lib/env";

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const KEY_BYTES = 32; // AES-256

/**
 * Decode CREDENTIALS_ENCRYPTION_KEY into raw key bytes.
 *
 * Accepts base64/base64url or hex so operators can paste whatever
 * `openssl rand` gave them. Read per call rather than cached at module load so
 * `next build` works without the secret present (matching lib/env.ts's lazy
 * validation), and so a rotated value takes effect without a rebuild.
 */
function key(): Buffer {
  const raw = requireEnv("CREDENTIALS_ENCRYPTION_KEY");
  const decoded = /^[0-9a-fA-F]+$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64url");

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${decoded.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return decoded;
}

/** Encrypt a credential for storage. Returns the versioned wire format. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a credential written by {@link seal}. Throws on a malformed, truncated,
 * or tampered value — callers should treat a throw as "this credential is
 * unusable, ask the user for it again" rather than crashing the request.
 */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed sealed credential");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES) {
    throw new Error("Malformed sealed credential: bad IV length");
  }

  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  // final() throws if the tag does not verify — that IS the integrity check.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Whether two credentials are equal, without leaking the answer through timing.
 * Used to skip a pointless write when a re-authentication yields the same token.
 */
export function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Aliases for the names PR #18's credential code imports. Same primitive, same
 * key: a second AES implementation reading a second env var would mean two
 * ciphertext formats in one database and a silent decrypt failure whenever a
 * row was written by the other half.
 */
export const encryptSecret = seal;
export const decryptSecret = open;

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
 *
 * Changing the key: set the new one as CREDENTIALS_ENCRYPTION_KEY and the old
 * one in CREDENTIALS_ENCRYPTION_KEY_PREVIOUS. Everything new is sealed under
 * the new key; what was sealed under the old one still opens.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { KEY_BYTES, keyBytes, keyList } from "@/lib/crypto/key-bytes";
import { optionalEnv, requireEnv } from "@/lib/env";

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size

function decoded(name: string, raw: string): Buffer {
  const bytes = keyBytes(raw);
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `${name} must decode to ${KEY_BYTES} bytes, got ${bytes.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return bytes;
}

/**
 * Decode CREDENTIALS_ENCRYPTION_KEY into raw key bytes.
 *
 * Accepts base64/base64url or hex so operators can paste whatever
 * `openssl rand` gave them. Read per call rather than cached at module load so
 * `next build` works without the secret present (matching lib/env.ts's lazy
 * validation), and so a rotated value takes effect without a rebuild.
 */
function key(): Buffer {
  return decoded("CREDENTIALS_ENCRYPTION_KEY", requireEnv("CREDENTIALS_ENCRYPTION_KEY"));
}

/** Keys credentials were sealed under before CREDENTIALS_ENCRYPTION_KEY, for
 * opening only. Read only when the current key fails, so a row sealed under
 * it never pays for them. */
function previousKeys(): Buffer[] {
  const raw = optionalEnv("CREDENTIALS_ENCRYPTION_KEY_PREVIOUS");
  if (!raw) return [];
  return keyList(raw).map((each) => decoded("CREDENTIALS_ENCRYPTION_KEY_PREVIOUS", each));
}

function openWith(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // final() throws if the tag does not verify — that IS the integrity check.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
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
 * or tampered value, or one no configured key opens — callers should treat a
 * throw as "this credential is unusable, ask the user for it again" rather
 * than crashing the request.
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

  // Outside the try: a missing or malformed current key is a setup error to
  // report as such, not a reason to fall back.
  const current = key();
  try {
    return openWith(current, iv, tag, ciphertext);
  } catch (failure) {
    for (const previous of previousKeys()) {
      try {
        return openWith(previous, iv, tag, ciphertext);
      } catch {
        // Not this one either; the current key's failure is the one to report.
      }
    }
    throw failure;
  }
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

/** Whether a stored value is one this module sealed (`v1.…`), rather than a
 * plaintext write from before the column holding it was sealed. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(`${VERSION}.`);
}

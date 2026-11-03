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
 * Wire format: `v2.<key fingerprint>.<iv>.<tag>.<ciphertext>`, each part
 * base64url but the fingerprint (8 hex: the start of the key's SHA-256). The
 * version prefix exists so the algorithm or key derivation can change later
 * without ambiguity about how an existing row was written. `v1.<iv>.<tag>.
 * <ciphertext>` (no fingerprint) is still read.
 *
 * The fingerprint says which key sealed a value, so one this server can't
 * open is told apart from a tampered one: another deployment, or a local dev
 * server pointed at this database with its own key, wrote it
 * ({@link ForeignKeyError}). 32 bits of a hash of a random 256-bit key give
 * nothing of the key away.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { requireEnv } from "@/lib/env";

const V1 = "v1";
const VERSION = "v2";
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

function fingerprintOf(keyBytes: Buffer): string {
  return createHash("sha256").update(keyBytes).digest("hex").slice(0, 8);
}

/** This server's CREDENTIALS_ENCRYPTION_KEY, as the fingerprint it seals with. */
export function keyFingerprint(): string {
  return fingerprintOf(key());
}

/** A value sealed under another CREDENTIALS_ENCRYPTION_KEY than this server's. */
export class ForeignKeyError extends Error {
  readonly sealedWith: string;
  readonly ours: string;

  constructor(sealedWith: string, ours: string) {
    super(
      `Sealed by a different CREDENTIALS_ENCRYPTION_KEY (fingerprint ${sealedWith}, ours ${ours}): ` +
        `another deployment or a local dev server is writing to this database.`,
    );
    this.name = "ForeignKeyError";
    this.sealedWith = sealedWith;
    this.ours = ours;
  }
}

/** Encrypt a credential for storage. Returns the versioned wire format. */
export function seal(plaintext: string): string {
  const keyBytes = key();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    fingerprintOf(keyBytes),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a credential written by {@link seal}. Throws on a malformed, truncated,
 * or tampered value — callers should treat a throw as "this credential is
 * unusable, ask the user for it again" rather than crashing the request.
 * One sealed under another key (a v2 with another fingerprint) throws
 * {@link ForeignKeyError}.
 */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  let body: string[];
  const keyBytes = key();
  if (parts.length === 4 && parts[0] === V1) {
    body = parts.slice(1);
  } else if (parts.length === 5 && parts[0] === VERSION && /^[0-9a-f]{8}$/.test(parts[1])) {
    const ours = fingerprintOf(keyBytes);
    if (parts[1] !== ours) throw new ForeignKeyError(parts[1], ours);
    body = parts.slice(2);
  } else {
    throw new Error("Malformed sealed credential");
  }

  const iv = Buffer.from(body[0], "base64url");
  const tag = Buffer.from(body[1], "base64url");
  const ciphertext = Buffer.from(body[2], "base64url");
  if (iv.length !== IV_BYTES) {
    throw new Error("Malformed sealed credential: bad IV length");
  }

  const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv);
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

/** Whether a stored value is one this module sealed (`v2.…`, or `v1.…`
 * from before), rather than a plaintext write from before the column holding
 * it was sealed. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(`${VERSION}.`) || stored.startsWith(`${V1}.`);
}

/** The key fingerprint a stored value was sealed with; null for v1 (none). */
export function sealedFingerprint(stored: string): string | null {
  const [version, fingerprint] = stored.split(".");
  return version === VERSION && fingerprint && /^[0-9a-f]{8}$/.test(fingerprint) ? fingerprint : null;
}

/**
 * Aliases for the names PR #18's credential code imports. Same primitive, same
 * key: a second AES implementation reading a second env var would mean two
 * ciphertext formats in one database and a silent decrypt failure whenever a
 * row was written by the other half.
 */
export const encryptSecret = seal;
export const decryptSecret = open;

/** What this server makes of a stored value: open, sealed under another key
 *  (with whose), or not to be opened at all (tampered, or a v1 under another
 *  key, which can't say whose). */
export type SealedStatus =
  | { kind: "opens"; plaintext: string }
  | { kind: "foreign"; sealedWith: string; ours: string }
  | { kind: "unreadable" };

export function sealedStatus(stored: string): SealedStatus {
  try {
    return { kind: "opens", plaintext: open(stored) };
  } catch (error) {
    if (error instanceof ForeignKeyError) return { kind: "foreign", sealedWith: error.sealedWith, ours: error.ours };
    return { kind: "unreadable" };
  }
}

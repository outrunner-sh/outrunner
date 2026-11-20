/**
 * Reading credential-encryption keys as operators paste them. Shared by
 * secret-box.ts and the startup check (lib/startup-env.ts), so it imports
 * nothing: server.ts loads the startup check before Next.
 */

/** AES-256. */
export const KEY_BYTES = 32;

/** A key's raw bytes: hex, or base64/base64url — whatever `openssl rand` printed. */
export function keyBytes(raw: string): Buffer {
  return /^[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64url");
}

/** The keys in a list setting, separated by commas or whitespace. */
export function keyList(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((part) => part.length > 0);
}

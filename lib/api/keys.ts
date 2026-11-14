/**
 * API keys, the parts with no database: what one looks like, how a request
 * carries it, and what a key may be named and how long it may live
 * (supabase/migrations/20261102120000_api_keys.sql; lib/db/api-keys.ts keeps
 * them). The public API also takes the CLI's own token (`or_cli_…`), so a
 * terminal signed in with `outrunner login` drives it without a key.
 */

import { bearerToken, hashSecret, randomSecret } from "@/lib/auth/cli-login";

/** What starts every API key, so one pasted somewhere it shouldn't be is
 *  recognised for what it is (and by secret scanners). */
export const API_KEY_PREFIX = "or_key_";

const API_KEY_PATTERN = /^or_key_[A-Za-z0-9_-]{43}$/;

/** A new key: the prefix and 32 random bytes, base64url. */
export function newApiKey(): string {
  return `${API_KEY_PREFIX}${randomSecret()}`;
}

/** How a key is stored and looked up: sha256, hex, as CLI tokens are. */
export const hashApiKey = hashSecret;

/** The last four characters, which the settings page shows to tell keys apart. */
export function keyHint(key: string): string {
  return key.slice(-4);
}

/** What signed a request in: an API key, or the CLI's token. */
export type ApiCredential = { kind: "api_key"; secret: string } | { kind: "cli_token"; secret: string };

/** The secret in `Authorization: Basic …` sent as the user name with no
 *  password (`curl -u $KEY:`), as clients written for Cursor's API send
 *  theirs; null for anything else. */
function basicSecret(header: string): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  return /^[A-Za-z0-9_-]+:$/.test(decoded) ? decoded.slice(0, -1) : null;
}

/** The credential in `Authorization: Bearer …` (or Basic, the key as the
 *  user name), or null for none or one of neither shape. */
export function apiCredential(headers: Headers): ApiCredential | null {
  const header = headers.get("authorization")?.trim() ?? "";
  const basic = basicSecret(header);
  if (basic) return apiCredential(new Headers({ authorization: `Bearer ${basic}` }));
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match && API_KEY_PATTERN.test(match[1])) return { kind: "api_key", secret: match[1] };
  const cli = bearerToken(headers);
  return cli ? { kind: "cli_token", secret: cli } : null;
}

/** A key's name as posted: trimmed, 1 to 80 characters. */
export function keyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 80 ? name : null;
}

/** The longest a key may be made to last. */
export const MAX_KEY_DAYS = 365;

/**
 * When a key stops working, from what was posted: `expires_in_days` (1 to
 * MAX_KEY_DAYS), or null for never. Undefined for anything else.
 */
export function keyExpiry(value: unknown, now = Date.now()): string | null | undefined {
  if (value === undefined || value === null || value === "never") return null;
  const days = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_KEY_DAYS) return undefined;
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Whether a stored key still signs anyone in. */
export function keyUsable(key: { revokedAt: string | null; expiresAt: string | null }, now = Date.now()): boolean {
  if (key.revokedAt) return false;
  return key.expiresAt === null || Date.parse(key.expiresAt) > now;
}

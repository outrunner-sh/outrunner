/**
 * A Runtime Computer's secret (runtime_computers.agent_secret) at rest.
 *
 * The secret is what a box proves itself with — every request it makes to the
 * server is HMAC-signed with it, and it mints the GitHub tokens the box's git
 * asks for — so a database dump alone handing it over would let an attacker
 * forge a box's requests. RLS keeps the column owner-scoped, but like
 * user_credentials (lib/db/credentials.ts) the value itself is sealed:
 * AES-256-GCM under CREDENTIALS_ENCRYPTION_KEY, so opening one needs the
 * database AND the app environment.
 *
 * Sealing is lazy: rows written before it hold plaintext, which
 * openAgentSecretOrNull passes through untouched, and every provision mints
 * and stores a fresh secret — so the column turns over on its own as boxes
 * are rebuilt.
 */

import { ForeignKeyError, isSealed, open, seal } from "@/lib/crypto/secret-box";

/** A Runtime Computer secret as it is stored: sealed. */
export function storeAgentSecret(plain: string): string {
  return seal(plain);
}

/**
 * The Runtime Computer secret as plaintext: sealed values open, a plaintext
 * value from before the column was sealed passes through. Null when there is
 * none, or when it will not open (a rotated CREDENTIALS_ENCRYPTION_KEY?): the
 * box cannot be reached or verified, which a re-provision fixes with a fresh
 * secret. Logs the computer's id — never the value.
 */
export function openAgentSecretOrNull(
  stored: string | null | undefined,
  computerId: string,
): string | null {
  if (!stored) return null;
  if (!isSealed(stored)) return stored;
  try {
    return open(stored);
  } catch (error) {
    if (error instanceof ForeignKeyError) {
      console.error(`Could not open Runtime Computer ${computerId}'s secret: ${error.message}`);
      return null;
    }
    console.error(
      `Could not open Runtime Computer ${computerId}'s secret; ` +
        `treating as unset (rotated CREDENTIALS_ENCRYPTION_KEY?)`,
    );
    return null;
  }
}

/**
 * Whether a GitHub token a sign-in brought replaces the one stored, when
 * this server can't open what's stored.
 *
 * Production's database has been written by a local dev server pointed at it
 * with its own CREDENTIALS_ENCRYPTION_KEY: each of its GitHub sign-ins sealed
 * the user's token under a key production can't open, and production then
 * treated the user as having none ("reconnect") until they signed in there
 * again. So a server that isn't the production deployment never overwrites a
 * stored token it can't read: it's another deployment's. Production does
 * (its sign-in is the one that should win), saying whose it replaces.
 *
 * Pure, for tests; lib/db/credentials.ts applies it.
 */

import type { SealedStatus } from "@/lib/crypto/secret-box";

export type OverwriteDecision =
  | { kind: "write" }
  | { kind: "unchanged" }
  /** Logged: what's stored is another server's, and stays. */
  | { kind: "refuse"; reason: string }
  /** Logged: what's stored is another server's, and production replaces it. */
  | { kind: "replace"; reason: string };

export function githubTokenOverwrite(
  stored: SealedStatus | null,
  sameAsStored: (plaintext: string) => boolean,
  production: boolean,
): OverwriteDecision {
  if (!stored) return { kind: "write" };
  if (stored.kind === "opens") return sameAsStored(stored.plaintext) ? { kind: "unchanged" } : { kind: "write" };
  const whose =
    stored.kind === "foreign"
      ? `sealed by a different CREDENTIALS_ENCRYPTION_KEY (fingerprint ${stored.sealedWith}, ours ${stored.ours}): another deployment or a local dev server is writing to this database`
      : "one this server's CREDENTIALS_ENCRYPTION_KEY can't open (another key's v1, or corrupted)";
  return production ? { kind: "replace", reason: whose } : { kind: "refuse", reason: whose };
}

/** Whether this server is the production deployment: a production build
 *  with its public address configured (lib/auth/complete-sign-in.ts). */
export function isProductionDeployment(): boolean {
  return process.env.NODE_ENV === "production" && !!process.env.RUNTIME_BASE_URL;
}

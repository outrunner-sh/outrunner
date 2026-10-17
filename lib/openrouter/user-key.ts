/**
 * Getting a user's own Outrunner-models key: the stored one, or a new one
 * created the first time. The storage is behind {@link UserKeyStore} so the
 * races and failures that decide whether the per-user cap holds are testable
 * without a database.
 *
 * What it guarantees:
 *   - one stored key per user: two first picks at once store one, and the
 *     other is disabled, never returned;
 *   - no live key without a stored id to revoke it by: one that can't be sealed
 *     or stored is disabled before the error goes back;
 *   - a stored key that can't be decrypted is reported, not replaced: a
 *     replacement would come with a fresh allowance, letting one user spend
 *     past the cap.
 */

import type { CreatedKey } from "@/lib/openrouter/keys";

export type StoredKey = { ciphertext: string | null; hash: string | null };

export interface UserKeyStore {
  read(): Promise<StoredKey>;
  /** Store the new key only if none is stored yet; false when another request
   *  stored one first. */
  claim(key: { ciphertext: string; hash: string; createdAt: string }): Promise<boolean>;
}

export type UserKeyDeps = {
  open(ciphertext: string): string;
  seal(plaintext: string): string;
  create(): Promise<CreatedKey>;
  disable(hash: string): Promise<void>;
  log(message: string, error?: unknown): void;
};

/** The stored key exists but can't be decrypted (the encryption key changed).
 *  Someone must look: replacing it would reset the user's allowance. */
export class StoredKeyUnreadableError extends Error {
  constructor() {
    super("This account's stored model key can't be read.");
    this.name = "StoredKeyUnreadableError";
  }
}

export async function ensureUserKey(store: UserKeyStore, deps: UserKeyDeps): Promise<string> {
  const stored = await store.read();
  if (stored.ciphertext) return openStored(stored, deps);

  const created = await deps.create();
  // From here a live key exists: any failure disables it before the error goes
  // back, so no key is left spending with no stored id to revoke it by.
  let won: boolean;
  try {
    won = await store.claim({
      ciphertext: deps.seal(created.key),
      hash: created.hash,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await disableQuietly(created.hash, deps);
    throw error;
  }
  if (won) return created.key;

  // Another request stored its key first: use that one, retire ours.
  await disableQuietly(created.hash, deps);
  const winner = await store.read();
  if (!winner.ciphertext) throw new Error("A key was claimed but none is stored.");
  return openStored(winner, deps);
}

function openStored(stored: StoredKey, deps: UserKeyDeps): string {
  try {
    return deps.open(stored.ciphertext as string);
  } catch (error) {
    deps.log(`Stored model key ${stored.hash ?? "(no id)"} can't be decrypted`, error);
    throw new StoredKeyUnreadableError();
  }
}

/** Best effort: a key that stays live is logged by its id, to disable by hand. */
async function disableQuietly(hash: string, deps: UserKeyDeps): Promise<void> {
  try {
    await deps.disable(hash);
  } catch (error) {
    deps.log(`Could not disable model key ${hash}; disable it by hand`, error);
  }
}

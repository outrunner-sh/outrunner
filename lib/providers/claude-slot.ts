/**
 * The Claude slot (Settings → Claude) holds a Claude subscription token
 * (`claude setup-token`, sk-ant-oat…). It used to take an Anthropic API key
 * too; an API key is now the Anthropic provider's (Settings → Providers), and
 * one still in the slot is moved there the first time the slot is read.
 *
 * Sealed, the two can't be told apart in SQL, so the move happens here, with
 * the storage behind {@link ClaudeSlotStore} so it tests without a database.
 *
 * What it guarantees:
 *   - only an API key moves: a subscription token stays, and so does a value
 *     that can't be opened (someone must look; nothing is lost);
 *   - nothing is lost: the key is stored with the provider before the slot is
 *     cleared, and an Anthropic key already saved there (newer) is kept;
 *   - safe to run twice, or twice at once: the copy keeps an existing key, and
 *     the slot is cleared only while it still holds what was moved.
 */

import { anthropicEnvVar } from "@/lib/runtime/anthropic-env";

export interface ClaudeSlotStore {
  /** The slot's sealed value, or null when empty. */
  readSlot(): Promise<string | null>;
  /** Store the sealed key as the user's Anthropic key, unless they have one. */
  copyToProvider(ciphertext: string, hint: string): Promise<void>;
  /** Empty the slot, if it still holds `ciphertext`. */
  clearSlotIf(ciphertext: string): Promise<void>;
}

/** Move an API key out of the Claude slot. Says whether one moved. */
export async function moveApiKeyFromClaudeSlot(
  store: ClaudeSlotStore,
  open: (ciphertext: string) => string,
): Promise<boolean> {
  const sealed = await store.readSlot();
  if (!sealed) return false;
  let credential: string;
  try {
    credential = open(sealed);
  } catch {
    return false;
  }
  if (anthropicEnvVar(credential) !== "ANTHROPIC_API_KEY") return false;
  // The same ciphertext: the key is never sealed again, or held longer than this.
  await store.copyToProvider(sealed, credential.slice(-4));
  await store.clearSlotIf(sealed);
  return true;
}

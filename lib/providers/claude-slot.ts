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
 *   - the move is one step (moveFromSlot, a database function): the slot is
 *     cleared only while it still holds the key, and the key is copied only
 *     by the call that cleared it. So two requests that read the same key
 *     move it once, and a slow one can't bring back a key the user removed
 *     after the first moved it;
 *   - an Anthropic key already saved with the provider (newer) is kept.
 */

import { anthropicEnvVar } from "@/lib/runtime/anthropic-env";

export interface ClaudeSlotStore {
  /** The slot's sealed value, or null when empty. */
  readSlot(): Promise<string | null>;
  /** At once: empty the slot if it still holds `ciphertext`, and only then
   *  store it as the user's Anthropic key, unless they have one. Whether this
   *  call emptied it. */
  moveFromSlot(ciphertext: string, hint: string): Promise<boolean>;
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
  return store.moveFromSlot(sealed, credential.slice(-4));
}

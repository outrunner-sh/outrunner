/**
 * Per-user Claude Code credential storage.
 *
 * A thin adapter over {@link lib/db/credentials}, keeping PR #18's API shape
 * for its settings page while storing into the one credential row this app
 * already has.
 *
 * PR #18 arrived with its own `user_claude_credentials` table. Keeping it would
 * mean two encrypted stores for one secret, and — the part that actually bites —
 * the workspace gate reads `user_credentials`, so a token connected through the
 * desktop flow would save "successfully" and still leave every workspace create
 * failing with "Connect Claude in Settings". Same secret, two homes, one of them
 * invisible to the code that needs it.
 *
 * So this door opens onto the same row the gate reads: connecting on the Claude
 * page satisfies it.
 */

import {
  clearAnthropicKey,
  credentialStatus,
  getAnthropicKey,
  setAnthropicKey,
  settleClaudeSlot,
} from "@/lib/db/credentials";
import { last4FromHint } from "@/lib/runtime/credentials/mask";

export type ClaudeTokenMeta = {
  /** Whether the owner has stored a token. */
  connected: boolean;
  /** Last 4 characters, for the UI to confirm which token — never the token. */
  last4: string | null;
  /** When the token was saved (ISO), null with none. A reconnect watches it
   *  change: `connected` stays true throughout one (lib/claude-connect.ts). */
  updatedAt: string | null;
};

/** Store (or replace) the owner's Claude token, encrypted at rest. */
export async function setClaudeToken(
  ownerId: string,
  token: string,
): Promise<void> {
  await setAnthropicKey(ownerId, token);
}

/** The owner's decrypted token, or null when they have not stored one. */
export async function getClaudeToken(ownerId: string): Promise<string | null> {
  return getAnthropicKey(ownerId);
}

/** Presence + last-4 metadata safe to expose to the signed-in owner. */
export async function getClaudeTokenMeta(
  ownerId: string,
): Promise<ClaudeTokenMeta> {
  // An Anthropic API key still here belongs to Settings → Providers now.
  await settleClaudeSlot(ownerId);
  const status = await credentialStatus(ownerId);
  // The stored hint is already the masked tail; surface just the last 4 so this
  // matches the shape PR #18's settings page renders.
  return {
    connected: status.anthropic.connected,
    last4: last4FromHint(status.anthropic.hint),
    updatedAt: status.anthropic.updatedAt,
  };
}

/** Remove the owner's stored token (disconnect). */
export async function deleteClaudeToken(ownerId: string): Promise<void> {
  await clearAnthropicKey(ownerId);
}

export { last4FromHint };

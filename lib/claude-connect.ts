import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";

/**
 * Whether `now` is a Claude subscription token saved since `before` was read:
 * how a page watching for the CLI (`outrunner claude`) knows it's done. From
 * none, any token is; on a reconnect, `connected` stays true throughout, so
 * only a later save is. A save whose time isn't known can't be told from the
 * one before it, so it isn't taken for one.
 */
export function claudeTokenLanded(now: ClaudeTokenMeta, before: ClaudeTokenMeta): boolean {
  if (!now.connected) return false;
  if (!before.connected) return true;
  return now.updatedAt !== null && now.updatedAt !== before.updatedAt;
}

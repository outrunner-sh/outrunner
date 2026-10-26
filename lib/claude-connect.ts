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

/**
 * Watch for the CLI's token: look now, every `everyMs`, and whenever
 * `onVisible` says the page is back, skipping a look while the page is hidden
 * or one is still out. The first look that finds a token saved since `before`
 * hands it to `onLanded`, once. The returned stop also drops a look still out:
 * its answer can come after a Cancel or a Disconnect, and mustn't undo it.
 */
export function watchClaudeToken({
  before,
  check,
  onLanded,
  everyMs,
  hidden,
  onVisible,
}: {
  before: ClaudeTokenMeta;
  check: () => Promise<ClaudeTokenMeta>;
  onLanded: (meta: ClaudeTokenMeta) => void;
  everyMs: number;
  hidden: () => boolean;
  /** Calls back when the page comes back into view; returns its unsubscribe. */
  onVisible: (look: () => void) => () => void;
}): () => void {
  let stopped = false;
  let out = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
  const look = () => {
    if (stopped || out || hidden()) return;
    out = true;
    check().then(
      (meta) => {
        out = false;
        if (!stopped && claudeTokenLanded(meta, before)) {
          stop();
          onLanded(meta);
        }
      },
      // A failed look is the next one's to retry.
      () => {
        out = false;
      },
    );
  };
  const timer = setInterval(look, everyMs);
  const unsubscribe = onVisible(look);
  look();
  return stop;
}

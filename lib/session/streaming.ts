/**
 * Pacing for Claude's replies as they arrive, after interior.dev's Streaming
 * Text: a steady reveal measured in time, not frames, so the rate holds on a
 * slow display; cut at word boundaries; and never a reveal for history.
 */

/** Characters a second at the resting pace (about 20 words a second). */
export const REVEAL_CHARS_PER_SECOND = 90;
/** However much arrives at once, it is all shown within this long. */
export const REVEAL_CATCH_UP_MS = 900;
/** A message stamped this recently is live; anything older is history, which
 *  appears at once (the stream replays a session's history when it opens). */
export const LIVE_WINDOW_MS = 15_000;

/** How many characters to show after `elapsedMs` more, from `shown` towards
 *  `target`: the resting pace, or faster when a large block arrived at once,
 *  so a backlog never takes longer than REVEAL_CATCH_UP_MS to clear. */
export function revealStep(shown: number, target: number, elapsedMs: number): number {
  if (shown >= target) return target;
  const backlog = target - shown;
  const perMs = Math.max(REVEAL_CHARS_PER_SECOND / 1000, backlog / REVEAL_CATCH_UP_MS);
  return Math.min(target, shown + Math.max(1, Math.floor(perMs * Math.max(0, elapsedMs))));
}

/** The first `count` characters, stopped at the end of a word, so the reveal
 *  never shows half a word (or half of a Markdown marker). */
export function revealedText(text: string, count: number): string {
  if (count >= text.length) return text;
  if (count <= 0) return "";
  const cut = text.slice(0, count);
  // Mid-word: back up to the last whitespace, unless there is none.
  if (/\S/.test(text[count] ?? "") && /\S$/.test(cut)) {
    const space = cut.search(/\s\S*$/);
    if (space > 0) return cut.slice(0, space);
  }
  return cut;
}

/** Whether a message was written moments ago (and so is arriving live), by its
 *  timestamp; an unreadable one counts as history. */
export function isLive(timestamp: string, nowMs: number): boolean {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && nowMs - at < LIVE_WINDOW_MS;
}

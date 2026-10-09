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

/**
 * The pace to reveal at, in characters per millisecond, decided when new text
 * arrives: the resting pace, or fast enough to show everything still hidden
 * within REVEAL_CATCH_UP_MS. Fixed until the next arrival — recomputed from
 * the shrinking backlog on every tick, it would slow as it went and never
 * meet the deadline.
 */
export function revealRate(shown: number, target: number): number {
  return Math.max(REVEAL_CHARS_PER_SECOND / 1000, Math.max(0, target - shown) / REVEAL_CATCH_UP_MS);
}

/** How many characters to show after `elapsedMs` more at `rate` (revealRate),
 *  from `shown` towards `target`: always at least one more, never past it.
 *  Rounded up, so a tick never falls behind the pace (rounding down lost a
 *  fraction every tick and missed the deadline). */
export function revealStep(shown: number, target: number, elapsedMs: number, rate: number): number {
  if (shown >= target) return target;
  return Math.min(target, shown + Math.max(1, Math.ceil(rate * Math.max(0, elapsedMs))));
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

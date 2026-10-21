/**
 * The optimistic echo's bookkeeping: the user's own bubble shows the moment
 * they send, and goes once the stream has recorded that turn.
 *
 * A bubble waits on a delivered-prompt count rather than on its text, so
 * duplicate messages and Claude's text-less tool-result user turns can't
 * confuse the match. The count is taken once the session has accepted the
 * prompt ({@link anchorPending}), not when it was typed: a prompt typed while
 * the session connects waits for the attach, and the history that arrives
 * meanwhile must not be counted as its own turn — which would drop the bubble
 * before the prompt had been sent at all. The stream can also record the
 * prompt before the session's answer comes back ({@link settlePending}).
 */

/** One bubble: `expect` is the delivered-prompt count the stream must pass for
 *  it to go, or null while the session has not taken the prompt yet. */
export type PendingPrompt = { id: string; text: string; expect: number | null };

/** Whether the stream has yet to record this bubble's turn, at `delivered`
 *  prompts. One not handed over yet always has. */
export function pendingShows(pending: PendingPrompt, delivered: number): boolean {
  return pending.expect === null || delivered < pending.expect;
}

/** `pending` without the bubbles the stream has caught up on. */
export function livePrompts(pending: PendingPrompt[], delivered: number): PendingPrompt[] {
  return pending.filter((p) => pendingShows(p, delivered));
}

/**
 * `pending` with `id` anchored against the history delivered by now: it goes
 * once the stream records one more prompt than the turns already in it — or
 * than an earlier bubble still waiting, so queued sends keep their order. The
 * bubbles already caught up on go.
 */
export function anchorPending(pending: PendingPrompt[], id: string, delivered: number): PendingPrompt[] {
  const kept = livePrompts(pending, delivered);
  const latest = kept.reduce((n, p) => Math.max(n, p.expect ?? 0), delivered);
  return kept.map((p) => (p.id === id ? { ...p, expect: latest + 1 } : p));
}

/**
 * `pending` once the session has taken `id`'s prompt: `recorded` is the
 * prompts the stream has recorded by now (userPrompts), and `sentAt` how many
 * it had when the prompt was handed over. The stream can record the prompt
 * before the session answers (a new session's first prompt, which launches
 * Claude): a prompt of its text among those recorded since it was handed over
 * is its own, so its bubble goes now rather than waiting on a turn already
 * past, which would show it twice until the next prompt. Otherwise it is
 * anchored ({@link anchorPending}).
 */
export function settlePending(
  pending: PendingPrompt[],
  id: string,
  recorded: string[],
  sentAt: number,
): PendingPrompt[] {
  const mine = pending.find((p) => p.id === id);
  if (mine && recorded.slice(sentAt).includes(mine.text)) {
    return livePrompts(pending, recorded.length).filter((p) => p.id !== id);
  }
  return anchorPending(pending, id, recorded.length);
}

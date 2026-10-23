/**
 * Reconnect backoff policy for the Conversation event WebSocket.
 *
 * Extracted as a pure function so the give-up threshold and the capped
 * exponential delay are unit-testable without a live socket. The hook
 * (use-conversation-stream) owns the side effects (timers, re-subscribe); this
 * module only decides *whether* and *when* to retry.
 */

/** First retry delay; doubles each consecutive failure up to the cap. */
export const RECONNECT_BASE_MS = 500;
/** Delay ceiling — reached before the attempt budget runs out (the raw delay at
 *  the last attempt would be 16s), so the tail is clamped instead of growing
 *  unbounded if the budget is ever raised. */
export const RECONNECT_MAX_MS = 8_000;
/** Consecutive failures after which automatic retry stops. The hook re-arms on
 *  focus/visibility/online for the idle-suspend case, so this only ends the
 *  *automatic* loop (e.g. an endpoint that is genuinely down), not recovery. */
export const MAX_RECONNECT_ATTEMPTS = 6; // ~0.5,1,2,4,8,8s (capped), then stop

export type ReconnectPlan =
  | { retry: true; delayMs: number }
  | { retry: false };

/**
 * Decide the next reconnect step from the count of consecutive failed attempts.
 *
 * `attempt` is 1-based: 1 is the first retry after an initial drop. Returns a
 * capped exponential backoff delay while within budget, and `{ retry: false }`
 * once the budget is exhausted so a permanently-dead endpoint isn't retried
 * forever.
 */
export function reconnectPlan(attempt: number): ReconnectPlan {
  if (attempt > MAX_RECONNECT_ATTEMPTS) return { retry: false };
  const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
  return { retry: true, delayMs };
}

/**
 * The `since` a re-armed retry run starts from. A re-arm after a close (the
 * socket is down) begins a fresh clock, so the elapsed time counts from this
 * retry and not from the drop that gave up — a give-up, then a focus an hour
 * later, would otherwise show an hour on the clock. Re-arming while the socket
 * is still open has nothing to time.
 */
export function rearmedSince(closed: boolean, at: number): number | null {
  return closed ? at : null;
}

/** What to say on screen about a dropped stream. */
export type DropNarration = {
  /** Set while the automatic reconnect loop is running after a drop. */
  reconnecting: { attempt: number; max: number; since: number } | null;
  /** The automatic retries are exhausted (or a manual one is under way):
   *  "lost connection", with the way back. */
  lost: boolean;
};

/**
 * What a dropped stream should say on screen. The automatic retry narrates
 * itself ("Reconnecting… attempt N of M"); one the user asked for does not —
 * its "lost connection" notice stays, button spinning, until it lands, rather
 * than blinking "Reconnecting…" over the button the user just pressed.
 */
export function dropNarration(input: {
  /** The socket closed, and the attachment itself hasn't failed. */
  dropped: boolean;
  /** Automatic retry gave up after MAX_RECONNECT_ATTEMPTS. */
  gaveUp: boolean;
  /** A reconnect the user asked for is under way. */
  manual: boolean;
  /** Consecutive failed reconnects so far this run; 0 before the first. */
  attempt: number;
  /** When this run of drops began (ms), null before the first close. */
  since: number | null;
}): DropNarration {
  if (!input.dropped) return { reconnecting: null, lost: false };
  if (input.manual) return { reconnecting: null, lost: true };
  return {
    reconnecting:
      !input.gaveUp && input.since !== null
        ? { attempt: input.attempt, max: MAX_RECONNECT_ATTEMPTS, since: input.since }
        : null,
    lost: input.gaveUp,
  };
}

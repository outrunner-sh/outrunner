import { BOX_GONE, SESSION_NOT_STARTED } from "@/lib/session/session-codes";

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
 * The next step after a /session refetch that the reconnect loop made has
 * failed (a 502 from the box's proxy for a few seconds, a box still settling).
 * The socket's close drives the loop, and with the refetch failed no socket
 * opens to close, so the failure itself takes the next attempt from the same
 * budget. `attempt` counts it, as reconnectPlan's does. A box that's gone, or
 * an agent that didn't start, says so instead: retrying can't help.
 */
export function attachFailurePlan(attempt: number, code: string | null): ReconnectPlan {
  if (code === BOX_GONE || code === SESSION_NOT_STARTED) return { retry: false };
  return reconnectPlan(attempt);
}

/**
 * The `since` a re-armed retry run starts from. A re-arm after a give-up
 * begins a fresh clock, so the elapsed time counts from this retry and not
 * from the drop it recovered from — a give-up, then a focus an hour later,
 * would otherwise show an hour on the clock. A re-arm while the automatic
 * loop is still running keeps the clock it has: that run is the same outage,
 * and the elapsed time is meant to show how long it has lasted.
 */
export function rearmedSince(prev: { gaveUp: boolean; since: number | null }, at: number): number | null {
  return prev.gaveUp ? at : prev.since;
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

/**
 * The Conversation socket's state (use-conversation-stream), as one slice: a
 * reducer keeps the hook's effect free of setState, and the signals update
 * from the same subscribe callbacks. `live`: this connection is open and
 * streaming (it opened, or a frame has arrived on it).
 */
export type WsStatus = {
  error: string | null;
  closed: boolean;
  live: boolean;
  /** Consecutive failed reconnects, mirrored from the ref for rendering. */
  attempt: number;
  /** When the current run of drops began (ms), for the elapsed time shown. */
  since: number | null;
  gaveUp: boolean;
  protocolErrorRef: string | null;
};
export type WsAction =
  | { kind: "opening" }
  | { kind: "opened" }
  | { kind: "frame-received" }
  | { kind: "closed"; attempt: number; at: number }
  | { kind: "gave-up" }
  | { kind: "rearm"; at: number }
  | { kind: "error"; message: string }
  | { kind: "protocol-error"; ref: string };

export const WS_OPEN: WsStatus = { error: null, closed: false, live: false, attempt: 0, since: null, gaveUp: false, protocolErrorRef: null };

export function wsReducer(state: WsStatus, action: WsAction): WsStatus {
  switch (action.kind) {
    case "opening":
      // A new connection (a reconnect, or the page shown again): not live
      // until it opens.
      return state.live ? { ...state, live: false } : state;
    case "opened":
      // The socket is open: the agent took its token and is streaming, so
      // the drop is over (its error with it), though no frame has come yet.
      return { ...WS_OPEN, live: true, protocolErrorRef: state.protocolErrorRef };
    case "frame-received":
      // A frame means it's open, for a socket whose open went unseen.
      return state.live && !state.closed && state.error === null
        ? state
        : { ...WS_OPEN, live: true, protocolErrorRef: state.protocolErrorRef };
    case "closed":
      return { ...state, closed: true, live: false, attempt: action.attempt, since: state.since ?? action.at };
    case "gave-up":
      return { ...state, gaveUp: true };
    case "rearm":
      // A fresh retry budget; the clock restarts only if the run had given up
      // (rearmedSince). A re-arm mid-outage keeps it, so the elapsed time
      // still shows how long the outage has lasted.
      return { ...state, attempt: 0, gaveUp: false, since: rearmedSince(state, action.at) };
    case "error":
      return { ...state, error: action.message };
    case "protocol-error":
      return { ...state, protocolErrorRef: state.protocolErrorRef ?? action.ref };
  }
}

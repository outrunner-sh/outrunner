/**
 * The Desktop tab's view of a session's desktop (components/workspace-desktop.tsx),
 * as a state machine: it asks Outrunner for the desktop, which starts it if it
 * isn't running and answers with a link to its VNC proxy; noVNC's client
 * opens a socket on that link; and the socket closes, cleanly or not, or the
 * desktop refuses it. The link is good for two minutes only (the open socket
 * outlives it), so every connection, a reconnect included, asks again.
 *
 * A live socket that drops is reconnected on its own, after each of
 * RECONNECT_DELAYS_MS. One was seen to drop every few minutes, and the tab
 * sat on Reconnect until the user clicked it, though the desktop and its
 * browser were still there. Only once those tries fail, or the desktop
 * refuses outright, does it ask the user. `tries` counts the reconnects in a
 * row; a connection that lasts STEADY_MS starts them afresh.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

export type DesktopView =
  /** Asking Outrunner for the desktop, which may start it (a second or two). */
  | { status: "starting"; attempt: number; tries?: number }
  /** A link in hand, the client opening its socket. */
  | { status: "connecting"; attempt: number; tries?: number }
  | { status: "connected"; attempt: number; tries?: number }
  /** The socket dropped: trying again on its own after `retryInMs`. */
  | { status: "reconnecting"; attempt: number; tries: number; retryInMs: number }
  /** The socket closed, or never opened: `reason` says which. */
  | { status: "disconnected"; attempt: number; reason: string }
  /** Outrunner said no: `message` is its words, `httpStatus` its answer's
   *  status (0 where it couldn't be reached or didn't answer in time). With
   *  `reload`, the page itself must be loaded again (the viewer's code
   *  didn't load, and the browser keeps that failure for the page's life). */
  | { status: "error"; attempt: number; message: string; httpStatus: number; reload?: boolean };

export type DesktopEvent =
  /** The tab opens, or Reconnect: ask for a fresh link. */
  | { type: "reconnect" }
  /** A reconnect's wait is over: ask for a fresh link, as the same tries. */
  | { type: "retry" }
  | { type: "opened" }
  | { type: "refused"; httpStatus: number; error?: string }
  | { type: "connect" }
  /** The socket opened, but the desktop never finished connecting. */
  | { type: "stalled" }
  /** noVNC's code didn't load. */
  | { type: "viewerfailed" }
  /** `lasted`: how long it had been connected, where it was. */
  | { type: "disconnect"; clean: boolean; lasted?: number }
  | { type: "securityfailure"; reason?: string };

export const FIRST_VIEW: DesktopView = { status: "starting", attempt: 0 };

/**
 * How long the route may take to answer: past its own bound on starting the
 * desktop (30 s), so its error, not this, is what's normally shown. Without
 * one, a hung request kept the tab on "Starting the desktop…" for good.
 */
export const OPEN_TIMEOUT_MS = 45_000;

/** How long a link in hand may take to become a picture of the desktop: the
 *  VNC handshake takes well under a second. */
export const CONNECT_TIMEOUT_MS = 20_000;

/** The waits before each reconnect in a row once a live socket drops: the
 *  first soon, as a dropped socket is usually just that, then longer. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000];

/** A connection that lasted this long was a good one: its drop starts the
 *  reconnects afresh. A shorter one's carries on counting, so a desktop that
 *  drops as soon as it connects isn't tried for ever. */
export const STEADY_MS = 30_000;

/** What the tab says when the route didn't answer in time. */
export const DESKTOP_TIMED_OUT = "The desktop took too long to start. Please try again.";

/** What the tab says when noVNC's code didn't load. */
export const VIEWER_FAILED = "The desktop viewer couldn't load. Reload the page to try again.";

/** What Outrunner's refusal says when it gave no words of its own. */
export const DESKTOP_UNREACHABLE = "Couldn't reach Outrunner to start the desktop. Please try again.";

/**
 * The view after `event`. Each connection is an `attempt`, which Reconnect
 * moves on: the panel opens a new one whenever it changes.
 */
export function desktopView(view: DesktopView, event: DesktopEvent): DesktopView {
  const attempt = view.attempt;
  // Set while the tab is reconnecting on its own: the tries so far.
  const tries = "tries" in view ? view.tries : undefined;
  switch (event.type) {
    case "reconnect":
      return { status: "starting", attempt: attempt + 1 };
    case "retry":
      return view.status === "reconnecting" ? { status: "starting", attempt: attempt + 1, tries: view.tries } : view;
    case "opened":
      return view.status === "starting" ? { status: "connecting", attempt, ...withTries(tries) } : view;
    case "refused": {
      // 409: this session has no desktop, or its box isn't running; either
      // way the route's words say which.
      const refused: DesktopView = {
        status: "error",
        attempt,
        message: event.error || (event.httpStatus === 0 ? DESKTOP_UNREACHABLE : "Couldn't start the desktop. Please try again."),
        httpStatus: event.httpStatus,
      };
      // Mid-reconnect, Outrunner out of reach or failing (no answer, a 5xx)
      // is tried again; a refusal (the box stopped) is said at once.
      const passing = event.httpStatus === 0 || event.httpStatus >= 500;
      return view.status === "starting" && tries !== undefined && passing ? retryOr(view, tries + 1, refused) : refused;
    }
    case "connect":
      return view.status === "connecting" ? { status: "connected", attempt, ...withTries(tries) } : view;
    case "stalled": {
      if (view.status !== "connecting") return view;
      const stalled: DesktopView = { status: "disconnected", attempt, reason: "The desktop didn't answer. Try reconnecting." };
      return tries !== undefined ? retryOr(view, tries + 1, stalled) : stalled;
    }
    case "viewerfailed":
      return { status: "error", attempt, message: VIEWER_FAILED, httpStatus: 0, reload: true };
    case "securityfailure":
      return {
        status: "disconnected",
        attempt,
        reason: event.reason ? `The desktop refused the connection: ${event.reason}.` : "The desktop refused the connection.",
      };
    case "disconnect": {
      // A security failure is followed by its disconnect: the failure's
      // reason is the one worth keeping. One already being retried is late.
      if (view.status === "disconnected" || view.status === "error" || view.status === "reconnecting") return view;
      const lost: DesktopView = { status: "disconnected", attempt, reason: disconnectReason(view.status, event.clean) };
      if (view.status === "connected") {
        // A good connection's drop starts the tries afresh; a short one's
        // carries on from where they were.
        const steady = event.lasted === undefined || event.lasted >= STEADY_MS;
        return retryOr(view, steady ? 1 : (tries ?? 0) + 1, lost);
      }
      // Never opened: a first connection says so; a reconnect tries again.
      return tries !== undefined ? retryOr(view, tries + 1, lost) : lost;
    }
  }
}

/** Reconnecting, as try `tries` of RECONNECT_DELAYS_MS; `giveUp` past them. */
function retryOr(view: DesktopView, tries: number, giveUp: DesktopView): DesktopView {
  const wait = RECONNECT_DELAYS_MS[tries - 1];
  return wait === undefined ? giveUp : { status: "reconnecting", attempt: view.attempt, tries, retryInMs: wait };
}

function withTries(tries: number | undefined): { tries?: number } {
  return tries === undefined ? {} : { tries };
}

/** Why the socket closed, in the words the panel shows. */
function disconnectReason(status: DesktopView["status"], clean: boolean): string {
  // Never opened: the proxy wasn't there, or the link had lapsed.
  if (status !== "connected") return "Couldn't connect to the desktop.";
  // Closed by the far end: the desktop stopped, or its box did.
  if (clean) return "The desktop closed the connection.";
  return "The connection to the desktop was lost.";
}

/**
 * Ask Outrunner for the desktop of session `workspaceId` (POST
 * /api/workspaces/[id]/desktop), starting it if it isn't running: the link
 * its VNC client connects to, or the refusal to show. Given up after
 * `timeoutMs`, as a refusal saying so.
 */
export async function openDesktop(
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = OPEN_TIMEOUT_MS,
  timeoutSignal: (milliseconds: number) => AbortSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
): Promise<{ url: string } | Extract<DesktopEvent, { type: "refused" }>> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workspaces/${workspaceId}/desktop`, {
      method: "POST",
      cache: "no-store",
      signal: timeoutSignal(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { type: "refused", httpStatus: 0, ...(timedOut && { error: DESKTOP_TIMED_OUT }) };
  }
  const body = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
  if (res.ok && typeof body.url === "string" && body.url) return { url: body.url };
  return { type: "refused", httpStatus: res.status, ...(typeof body.error === "string" && { error: body.error }) };
}

/**
 * How often, at most, the Desktop tab says the user is using the desktop
 * while they do: well inside the 12 seconds after which the agent's tools
 * count them as done (runtime-agent/internal/desktop UserIdleAfter).
 */
export const IN_USE_EVERY_MS = 5_000;

/**
 * What to call on each of the user's moves on the desktop: it tells Outrunner
 * (POST /api/workspaces/[id]/desktop/activity), at most every
 * IN_USE_EVERY_MS, so the agent's desktop tools wait for them. A request that
 * fails is let go: their next move sends another.
 */
export function inUseReporter(workspaceId: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): () => void {
  let last = -Infinity;
  return () => {
    const at = now();
    if (at - last < IN_USE_EVERY_MS) return;
    last = at;
    fetchImpl(`/api/workspaces/${workspaceId}/desktop/activity`, { method: "POST", cache: "no-store", keepalive: true }).catch(() => {});
  };
}

/** What the Desktop tab says when it couldn't reach Outrunner to open the
 *  browser. */
export const BROWSER_UNREACHABLE = "Couldn't reach Outrunner to open the browser. Please try again.";

/**
 * Open the web browser on session `workspaceId`'s desktop (POST
 * /api/workspaces/[id]/desktop/browser): null once it's on its way up, else
 * what to tell the user.
 */
export async function openDesktopBrowser(workspaceId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workspaces/${workspaceId}/desktop/browser`, { method: "POST", cache: "no-store" });
  } catch {
    return BROWSER_UNREACHABLE;
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" && body.error ? body.error : BROWSER_UNREACHABLE;
}

/**
 * The Desktop tab's view of a session's desktop (components/workspace-desktop.tsx),
 * as a state machine: it asks Outrunner for the desktop, which starts it if it
 * isn't running and answers with a link to its VNC proxy; noVNC's client
 * opens a socket on that link; and the socket closes, cleanly or not, or the
 * desktop refuses it. The link is good for two minutes only (the open socket
 * outlives it), so every connection, a reconnect included, asks again.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

export type DesktopView =
  /** Asking Outrunner for the desktop, which may start it (a second or two). */
  | { status: "starting"; attempt: number }
  /** A link in hand, the client opening its socket. */
  | { status: "connecting"; attempt: number }
  | { status: "connected"; attempt: number }
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
  | { type: "opened" }
  | { type: "refused"; httpStatus: number; error?: string }
  | { type: "connect" }
  /** The socket opened, but the desktop never finished connecting. */
  | { type: "stalled" }
  /** noVNC's code didn't load. */
  | { type: "viewerfailed" }
  | { type: "disconnect"; clean: boolean }
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
  switch (event.type) {
    case "reconnect":
      return { status: "starting", attempt: attempt + 1 };
    case "opened":
      return view.status === "starting" ? { status: "connecting", attempt } : view;
    case "refused":
      // 409: this session has no desktop, or its box isn't running; either
      // way the route's words say which.
      return {
        status: "error",
        attempt,
        message: event.error || (event.httpStatus === 0 ? DESKTOP_UNREACHABLE : "Couldn't start the desktop. Please try again."),
        httpStatus: event.httpStatus,
      };
    case "connect":
      return view.status === "connecting" ? { status: "connected", attempt } : view;
    case "stalled":
      return view.status === "connecting"
        ? { status: "disconnected", attempt, reason: "The desktop didn't answer. Try reconnecting." }
        : view;
    case "viewerfailed":
      return { status: "error", attempt, message: VIEWER_FAILED, httpStatus: 0, reload: true };
    case "securityfailure":
      return {
        status: "disconnected",
        attempt,
        reason: event.reason ? `The desktop refused the connection: ${event.reason}.` : "The desktop refused the connection.",
      };
    case "disconnect":
      // A security failure is followed by its disconnect: the failure's
      // reason is the one worth keeping.
      if (view.status === "disconnected" || view.status === "error") return view;
      return { status: "disconnected", attempt, reason: disconnectReason(view.status, event.clean) };
  }
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

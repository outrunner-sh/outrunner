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
   *  status (0 where it couldn't be reached). */
  | { status: "error"; attempt: number; message: string; httpStatus: number };

export type DesktopEvent =
  /** The tab opens, or Reconnect: ask for a fresh link. */
  | { type: "reconnect" }
  | { type: "opened" }
  | { type: "refused"; httpStatus: number; error?: string }
  | { type: "connect" }
  | { type: "disconnect"; clean: boolean }
  | { type: "securityfailure"; reason?: string };

export const FIRST_VIEW: DesktopView = { status: "starting", attempt: 0 };

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
 * its VNC client connects to, or the refusal to show.
 */
export async function openDesktop(
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string } | Extract<DesktopEvent, { type: "refused" }>> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workspaces/${workspaceId}/desktop`, { method: "POST", cache: "no-store" });
  } catch {
    return { type: "refused", httpStatus: 0 };
  }
  const body = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
  if (res.ok && typeof body.url === "string" && body.url) return { url: body.url };
  return { type: "refused", httpStatus: res.status, ...(typeof body.error === "string" && { error: body.error }) };
}

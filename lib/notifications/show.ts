/**
 * Showing a notification where the user is: the Mac app's own (its
 * notification plugin, which the webview's missing Notification API can't
 * stand in for), else the browser's, once they've allowed it. Which ones to
 * show is {@link shouldShow}'s: not the session already on screen.
 */

import { tauriCore } from "@/lib/desktop/local-runtime";

export type Shown = { id: string; workspaceId: string; title: string; body: string };

/**
 * Whether to show a notification now: the user wants them here, and it isn't
 * about the session they're looking at (on screen, in a window in front). A
 * session open in a tab in the background is told like any other.
 */
export function shouldShow(
  notification: { workspaceId: string },
  where: { browserOn: boolean; onScreen: string | undefined; looking: boolean },
): boolean {
  if (!where.browserOn) return false;
  return !(where.looking && where.onScreen === notification.workspaceId);
}

/** Ids already shown, so a second tab doesn't show them again; the newest
 *  few hundred are kept. */
export function rememberShown(kept: string[], id: string, max = 200): string[] {
  return [...kept.filter((k) => k !== id), id].slice(-max);
}

export type Permission = "granted" | "denied" | "default" | "unsupported";

/** Whether notifications may be shown here. */
export async function notificationPermission(): Promise<Permission> {
  const core = tauriCore();
  if (core) {
    try {
      return ((await core.invoke("plugin:notification|is_permission_granted")) as boolean | null) ? "granted" : "default";
    } catch {
      // A Mac app from before its notification plugin: nothing to show with.
      return "unsupported";
    }
  }
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Ask to show notifications (from a click: browsers ignore it otherwise). */
export async function askPermission(): Promise<Permission> {
  const core = tauriCore();
  if (core) {
    try {
      const answer = (await core.invoke("plugin:notification|request_permission")) as string;
      return answer === "granted" ? "granted" : answer === "denied" ? "denied" : "default";
    } catch {
      return "unsupported";
    }
  }
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.requestPermission();
}

/** Show one; a click opens its session. Quietly nothing where it can't. */
export async function showNotification(notification: Shown, open: (workspaceId: string) => void): Promise<void> {
  const core = tauriCore();
  if (core) {
    // The Mac app brings itself forward on a click; the session is the
    // user's to pick from the sidebar's Needs you.
    await core
      .invoke("plugin:notification|notify", { options: { title: notification.title, body: notification.body } })
      .catch(() => {});
    return;
  }
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  const shown = new Notification(notification.title, { body: notification.body, tag: notification.id });
  shown.onclick = () => {
    window.focus();
    open(notification.workspaceId);
    shown.close();
  };
}

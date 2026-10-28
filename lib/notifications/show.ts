/**
 * Showing a notification in the browser, once the user has allowed it. Which
 * ones to show is {@link shouldShow}'s: not the session already on screen.
 */

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

export type Permission = NotificationPermission | "unsupported";

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Whether one can be shown here now: a Notification API, and allowed. */
export function canShowNotifications(): boolean {
  return supported() && Notification.permission === "granted";
}

/** Whether notifications may be shown here. */
export async function notificationPermission(): Promise<Permission> {
  return supported() ? Notification.permission : "unsupported";
}

/** Ask to show notifications (from a click: browsers ignore it otherwise). */
export async function askPermission(): Promise<Permission> {
  return supported() ? Notification.requestPermission() : "unsupported";
}

/** Show one; a click opens its session. Quietly nothing where it can't. */
export async function showNotification(notification: Shown, open: (workspaceId: string) => void): Promise<void> {
  if (!canShowNotifications()) return;
  const shown = new Notification(notification.title, { body: notification.body, tag: notification.id });
  shown.onclick = () => {
    window.focus();
    open(notification.workspaceId);
    shown.close();
  };
}

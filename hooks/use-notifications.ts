"use client";

import { useEffect, useRef } from "react";

import { rememberShown, shouldShow, showNotification, type Shown } from "@/lib/notifications/show";

/** How often the page asks. A tab in the background is asked less often by
 *  the browser itself; it still hears within a minute or so. */
const POLL_MS = 15_000;

/** Ids shown in any tab of this browser, so each is shown once. */
const SHOWN_KEY = "outrunner-notified";

function readShown(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "[]");
    return Array.isArray(kept) ? kept.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Mark `id` shown here; false when another tab already showed it. */
function claim(id: string): boolean {
  const kept = readShown();
  if (kept.includes(id)) return false;
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify(rememberShown(kept, id)));
  } catch {
    // Storage off: this tab shows it, and maybe another does too.
  }
  return true;
}

/**
 * The frame's part, mounted once: ask the server for the user's notifications
 * as they come (lib/notifications) and show each one in the browser, unless
 * it's about the session on screen in a window in front, or the user turned
 * them off. Starts from now: what happened while the page was
 * closed is in the sidebar, not a burst of notifications.
 */
export function useNotificationsFeed({
  onScreen,
  open,
}: {
  /** The cloud session on screen, if one is. */
  onScreen: string | undefined;
  /** Open a session (a click on its notification). */
  open: (workspaceId: string) => void;
}): void {
  const here = useRef({ onScreen, open });
  useEffect(() => {
    here.current = { onScreen, open };
  });

  useEffect(() => {
    let stopped = false;
    let after = new Date().toISOString();
    const read = async () => {
      try {
        const response = await fetch(`/api/notifications?after=${encodeURIComponent(after)}`, { cache: "no-store" });
        if (!response.ok || stopped) return;
        const body = (await response.json()) as {
          notifications: Array<Shown & { kind: string; createdAt: string }>;
          browser: boolean;
          kinds: string[];
        };
        for (const notification of body.notifications) {
          after = notification.createdAt;
          if (!body.kinds.includes(notification.kind)) continue;
          const looking = document.visibilityState === "visible" && document.hasFocus();
          if (!shouldShow(notification, { browserOn: body.browser, onScreen: here.current.onScreen, looking })) continue;
          if (!claim(notification.id)) continue;
          await showNotification(notification, (id) => here.current.open(id));
        }
      } catch {
        // Offline for a moment: the next read catches up.
      }
    };
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
}

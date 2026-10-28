"use client";

import { useEffect, useRef } from "react";

import { store, useStore } from "@/lib/client/store";
import type { SessionStanding, Standing } from "@/lib/session/standing";

/**
 * Where each of the user's cloud sessions stands (lib/session/standing.ts),
 * shared by the sidebar, the sessions list and the shortcut that jumps to the
 * next one needing you. Seeded from the layout's read and kept live by the
 * frame's poll (useStandingsFeed); a mark the user makes shows at once and is
 * confirmed by the next read.
 */
const STANDINGS = store<Record<string, SessionStanding>>({});
const NONE: Record<string, SessionStanding> = {};

/** How often the frame asks, while the page is in sight. The server's watch
 *  reads a session every few seconds after a send, and every two minutes
 *  otherwise; this only has to carry that to the page. */
const POLL_MS = 10_000;

export function useStandings(): Record<string, SessionStanding> {
  return useStore(STANDINGS, NONE);
}

export function standingsNow(): Record<string, SessionStanding> {
  return STANDINGS.get();
}

function patch(id: string, change: Partial<SessionStanding>): void {
  const current = STANDINGS.get()[id];
  if (!current) return;
  STANDINGS.set({ ...STANDINGS.get(), [id]: { ...current, ...change } });
}

let refreshNow: (() => void) | null = null;

/**
 * Change the user's marks on a session: pin it, move it to a group (null: back
 * to where the server puts it), or mark it seen. Shown at once; throws with a
 * sentence to show when it couldn't be saved, and the next read puts it back.
 */
export async function markSession(
  id: string,
  change: { pinned?: boolean; movedTo?: Standing | null; seen?: true },
): Promise<void> {
  if (change.pinned !== undefined) patch(id, { pinned: change.pinned });
  if (change.movedTo) patch(id, { standing: change.movedTo, moved: true, reason: null });
  if (change.seen) patch(id, { unread: false });
  let response: Response;
  try {
    response = await fetch(`/api/workspaces/${id}/marks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    });
  } catch {
    refreshNow?.();
    throw new Error("Could not reach Outrunner. Check your connection and try again.");
  }
  // A move back to automatic is placed by the server: read it now.
  if (!response.ok || change.movedTo === null) refreshNow?.();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't save that. Please try again.");
  }
}

/**
 * The frame's part, mounted once: seed the store from the layout's read, ask
 * the server again every few seconds while the page is in sight (and at once
 * on coming back to it), and mark the session on screen seen whenever it has
 * a reply the user hasn't. `onListChanged` is called when the server lists
 * sessions the page doesn't have, or no longer lists one it does (made or
 * deleted elsewhere), for the page to re-read them.
 */
export function useStandingsFeed({
  initial,
  ids,
  onScreen,
  onListChanged,
}: {
  initial: Record<string, SessionStanding> | undefined;
  /** The cloud sessions the page lists. */
  ids: string[];
  /** The cloud session on screen, if one is. */
  onScreen: string | undefined;
  onListChanged: () => void;
}): void {
  useEffect(() => {
    if (initial) STANDINGS.set(initial);
  }, [initial]);

  const listed = useRef(ids);
  const changed = useRef(onListChanged);
  useEffect(() => {
    listed.current = ids;
    changed.current = onListChanged;
  });

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const read = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const response = await fetch("/api/sessions/standings", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { standings: Record<string, SessionStanding>; ids: string[] };
        if (stopped) return;
        STANDINGS.set(body.standings);
        const have = new Set(listed.current);
        if (body.ids.length !== have.size || body.ids.some((id) => !have.has(id))) changed.current();
      } catch {
        // Offline for a moment: the next read catches up.
      } finally {
        busy = false;
      }
    };
    refreshNow = () => void read();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      refreshNow = null;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // The session on screen, read while in sight: its replies aren't unread.
  const standings = useStandings();
  const unreadOnScreen = onScreen ? standings[onScreen]?.unread === true : false;
  useEffect(() => {
    if (!onScreen || !unreadOnScreen) return;
    const mark = () => {
      if (document.visibilityState === "visible") void markSession(onScreen, { seen: true }).catch(() => {});
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [onScreen, unreadOnScreen]);
}

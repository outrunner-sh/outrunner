"use client";

/**
 * The owner's Missions (GET /api/missions), one store for the page: the
 * sidebar's Missions section, the Runners pane and the toasts all read it.
 * Looked at every few seconds while the tab is visible and at once when it
 * comes back; a look that answers the same keeps the same object, so nothing
 * re-renders, and nothing flickers. What changed between looks that the user
 * should hear about (a pull request ready, a Mission needing them) goes to
 * whoever listens for news.
 */

import { useEffect, useSyncExternalStore } from "react";

import { type MissionView, newsBetween } from "@/lib/missions/view";

const EVERY_MS = 8_000;

export type MissionNews = ReturnType<typeof newsBetween>[number];

type Snapshot = { loaded: boolean; missions: MissionView[]; error: string | null };

let snapshot: Snapshot = { loaded: false, missions: [], error: null };
let raw = "";
const listeners = new Set<() => void>();
const newsListeners = new Set<(news: MissionNews[]) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let users = 0;

function publish(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

/** Look again now (after an action here, or the tab coming back). */
export function refreshMissions(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch("/api/missions", { cache: "no-store" });
      if (!response.ok) throw new Error(`Missions answered ${response.status}`);
      const text = await response.text();
      if (text === raw && snapshot.loaded) return;
      const { missions } = JSON.parse(text) as { missions: MissionView[] };
      const before = snapshot.loaded ? snapshot.missions : null;
      raw = text;
      publish({ loaded: true, missions, error: null });
      const news = newsBetween(before, missions);
      if (news.length) for (const l of newsListeners) l(news);
    } catch (error) {
      // The last answer stays up; the next look tries again.
      if (snapshot.error === null) publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (document.visibilityState === "visible") await refreshMissions();
    if (users > 0) schedule();
  }, EVERY_MS);
}

function onVisible() {
  if (document.visibilityState === "visible") void refreshMissions();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER: Snapshot = { loaded: false, missions: [], error: null };

/** The Missions, kept fresh while anything on the page shows them. */
export function useMissions(): Snapshot {
  useEffect(() => {
    users++;
    if (users === 1) {
      void refreshMissions();
      schedule();
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      users--;
      if (users === 0) {
        if (timer) clearTimeout(timer);
        timer = null;
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, () => snapshot, () => SERVER);
}

/** One Mission from the store, or null. */
export function useMission(id: string | undefined): { loaded: boolean; mission: MissionView | null } {
  const { loaded, missions } = useMissions();
  return { loaded, mission: (id && missions.find((m) => m.id === id)) || null };
}

/** Hear what changed that the user should know of. */
export function useMissionNews(listener: (news: MissionNews[]) => void): void {
  useEffect(() => {
    newsListeners.add(listener);
    return () => {
      newsListeners.delete(listener);
    };
  }, [listener]);
}

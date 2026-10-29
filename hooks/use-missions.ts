"use client";

/**
 * The owner's Runners (GET /api/missions), one store for the page: the
 * sidebar's Runners, the Ships pane and the toasts all read it.
 * Looked at every few seconds while the tab is visible and at once when it
 * comes back; a look that answers the same keeps the same object, so nothing
 * re-renders, and nothing flickers. What the user should hear about (a pull
 * request ready, a Runner needing them) comes as notifications
 * (components/missions/mission-toasts.tsx), not from here.
 *
 * The store itself — and what this browser kept of the last answer, so a
 * re-entry paints it at once — is lib/missions/kept-missions.ts. This is the
 * looking: the poll, and the server's answer replacing what was kept.
 */

import { useEffect } from "react";

import {
  missionsAnswered,
  missionsGeneration,
  missionsSnapshot,
  publishMissions,
  rememberMissions,
  useMissionsSnapshot,
  type MissionSnapshot,
} from "@/lib/missions/kept-missions";
import type { MissionView } from "@/lib/missions/view";

const EVERY_MS = 8_000;

let raw = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let users = 0;

/** Look again now (after an action here, or the tab coming back). */
export function refreshMissions(): Promise<void> {
  if (inflight) return inflight;
  // The org (or the user) as this look starts: an answer to a page that has
  // since been forgotten doesn't land.
  const started = missionsGeneration();
  inflight = (async () => {
    try {
      const response = await fetch("/api/missions", { cache: "no-store" });
      if (!response.ok) throw new Error(`Missions answered ${response.status}`);
      const text = await response.text();
      if (started !== missionsGeneration()) return;
      if (text === raw && missionsSnapshot().loaded) return;
      const { missions } = JSON.parse(text) as { missions: MissionView[] };
      raw = text;
      // The server's answer replaces whatever was kept, and is kept in turn.
      publishMissions({ loaded: true, missions, error: null });
      rememberMissions(missions);
    } catch (error) {
      if (started !== missionsGeneration()) return;
      // The last answer stays up; the next look tries again.
      const current = missionsSnapshot();
      if (current.error === null) publishMissions({ ...current, error: error instanceof Error ? error.message : String(error) });
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

/** The Runners, kept fresh while anything on the page shows them. */
export function useMissions(): MissionSnapshot {
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
  return useMissionsSnapshot();
}

/** One Runner from the store, or null. `loaded` says this Runner is known —
 *  in the server's answer, or in what was kept — so a pane waits rather than
 *  showing it as empty. What was kept is only ever the tail of an answer, so
 *  before the server has spoken a Runner missing from it is waited for; once
 *  it has, missing means missing, and the pane says so. */
export function useMission(id: string | undefined): { loaded: boolean; mission: MissionView | null } {
  const { loaded, missions } = useMissions();
  const mission = (id && missions.find((m) => m.id === id)) || null;
  return { loaded: loaded && (mission !== null || missionsAnswered()), mission };
}

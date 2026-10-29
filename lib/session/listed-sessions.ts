"use client";

import { forgetWithKeptPages } from "@/lib/client/kept-page";
import { store, useStore } from "@/lib/client/store";
import type { SessionListEntry } from "@/lib/session/session-list";

/**
 * The sessions list's last answer (GET /api/sessions), for the page's life:
 * going back to Sessions shows it at once, and reads the org again only once
 * it is {@link LISTED_FRESH_FOR_MS} old (components/sessions-list.tsx).
 *
 * What this tab does to a session elsewhere — archived from the sidebar or a
 * session's header, deleted — changes the kept answer too, so the list never
 * shows it as it was; anything it can't say (an archive the server refused)
 * makes the answer stale, read again on the next look.
 */
export const LISTED_FRESH_FOR_MS = 30_000;

export type ListedSessions = { sessions: SessionListEntry[]; at: number };
const LISTED = store<ListedSessions | null>(null);
// Another org's, or another user's, once the org switches or they sign out.
forgetWithKeptPages(() => LISTED.set(null));

export function useListedSessions(): ListedSessions | null {
  return useStore(LISTED, null);
}

export function listedSessions(): ListedSessions | null {
  return LISTED.get();
}

/** Keep the answer the server just gave. */
export function rememberListedSessions(sessions: SessionListEntry[]): void {
  LISTED.set({ sessions, at: Date.now() });
}

/** Whether the kept answer is recent enough to show without asking again. */
export function listedIsFresh(listed: ListedSessions | null, now = Date.now()): boolean {
  return listed !== null && now - listed.at < LISTED_FRESH_FOR_MS;
}

/** Show session `id` with `status` in the kept answer: archived elsewhere. */
export function patchListedSession(id: string, status: SessionListEntry["status"]): void {
  const listed = LISTED.get();
  if (!listed?.sessions.some((s) => s.id === id)) return;
  LISTED.set({ ...listed, sessions: listed.sessions.map((s) => (s.id === id ? { ...s, status } : s)) });
}

/** Drop session `id` from the kept answer: deleted. */
export function forgetListedSession(id: string): void {
  const listed = LISTED.get();
  if (!listed?.sessions.some((s) => s.id === id)) return;
  LISTED.set({ ...listed, sessions: listed.sessions.filter((s) => s.id !== id) });
}

/** The kept answer may be wrong now: shown until the list reads it again,
 *  which it does at once. */
export function staleListedSessions(): void {
  const listed = LISTED.get();
  if (listed) LISTED.set({ ...listed, at: 0 });
}

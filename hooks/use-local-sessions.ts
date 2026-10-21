"use client";

import { useEffect } from "react";

import { useSharedResource } from "@/hooks/use-shared-resource";
import { sharedResource } from "@/lib/client/shared-resource";
import { listLocalSessions, tauriCore, type LocalSession } from "@/lib/desktop/local-runtime";

export type LocalSessions =
  | { state: "loading"; sessions: LocalSession[] }
  /** Not the Outrunner Mac app: there are no local sessions to list here. */
  | { state: "unavailable"; sessions: LocalSession[] }
  | { state: "ready"; sessions: LocalSession[] }
  | { state: "error"; sessions: LocalSession[]; message: string };

type Listed = { available: boolean; sessions: LocalSession[] };

/** This Mac's sessions, one list for the page: the sidebar and a session's
 *  page read the same one rather than each asking the Mac. */
const MAC_SESSIONS = sharedResource<Listed>(async () => {
  if (!tauriCore()) return { available: false, sessions: [] };
  return { available: true, sessions: await listLocalSessions() };
}, { available: false, sessions: [] });

/**
 * This Mac's local sessions, from the agent here. They are not in the shared
 * database, so every list of them is read from the Mac itself. The last list
 * read shows at once; it is read again on mount and when the window regains
 * focus, since a session may have been made in another view.
 */
export function useLocalSessions(): LocalSessions & { refresh: () => void } {
  const listed = useSharedResource(MAC_SESSIONS);

  useEffect(() => {
    void MAC_SESSIONS.refresh();
    const onFocus = () => void MAC_SESSIONS.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return { ...localSessionsState(listed), refresh: refreshLocalSessions };
}

function refreshLocalSessions(): void {
  void MAC_SESSIONS.refresh();
}

function localSessionsState(listed: ReturnType<typeof MAC_SESSIONS.getSnapshot>): LocalSessions {
  const { sessions } = listed.value;
  if (listed.status === "loading") return { state: "loading", sessions };
  if (listed.status === "error") return { state: "error", sessions, message: listed.error };
  return { state: listed.value.available ? "ready" : "unavailable", sessions };
}

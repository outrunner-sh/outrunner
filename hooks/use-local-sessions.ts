"use client";

import { useCallback, useEffect, useState } from "react";

import { useSharedResource } from "@/hooks/use-shared-resource";
import { sharedResource } from "@/lib/client/shared-resource";
import { listLocalSessions, LocalRuntimeError, tauriCore, type LocalSession } from "@/lib/desktop/local-runtime";

export type LocalSessions =
  | { state: "loading"; sessions: LocalSession[] }
  /** Not the Outrunner Mac app: there are no local sessions to list here. */
  | { state: "unavailable"; sessions: LocalSession[] }
  | { state: "ready"; sessions: LocalSession[] }
  /** The list didn't answer. `code` is the Mac app's own ("agent-did-not-start"),
   *  when it gave one, and `reason` what followed it. */
  | { state: "error"; sessions: LocalSession[]; message: string; code: string | null; reason: string | null };

type Listed = { available: boolean; sessions: LocalSession[] };

/** Why the last look failed, beside the list it failed to read: the resource
 *  keeps the sentence, this keeps which kind it was — the Mac app's own code
 *  — for the page that acts on it. */
let lastFailure: { code: string | null; reason: string | null } | null = null;

/** This Mac's sessions, one list for the page: the sidebar and a session's
 *  page read the same one rather than each asking the Mac. */
const MAC_SESSIONS = sharedResource<Listed>(async () => {
  if (!tauriCore()) return { available: false, sessions: [] };
  try {
    const sessions = await listLocalSessions();
    lastFailure = null;
    return { available: true, sessions };
  } catch (error) {
    lastFailure = error instanceof LocalRuntimeError ? { code: error.code, reason: error.reason } : null;
    throw error;
  }
}, { available: false, sessions: [] });

/**
 * This Mac's local sessions, from the agent here. They are not in the shared
 * database, so every list of them is read from the Mac itself. The last list
 * read shows at once; it is read again on mount and when the window regains
 * focus, since a session may have been made in another view. `refreshing`
 * says a look asked for here is under way, so a way to try again can say it
 * is working: a look already under way is shared, not queued.
 */
export function useLocalSessions(): LocalSessions & { refresh: () => void; refreshing: boolean } {
  const listed = useSharedResource(MAC_SESSIONS);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback((): void => {
    setRefreshing(true);
    // A look already under way is the one that answers this too.
    void MAC_SESSIONS.refresh().finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    void MAC_SESSIONS.refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { ...localSessionsState(listed), refresh, refreshing };
}

function localSessionsState(listed: ReturnType<typeof MAC_SESSIONS.getSnapshot>): LocalSessions {
  const { sessions } = listed.value;
  if (listed.status === "loading") return { state: "loading", sessions };
  if (listed.status === "error")
    return {
      state: "error",
      sessions,
      message: listed.error,
      code: lastFailure?.code ?? null,
      reason: lastFailure?.reason ?? null,
    };
  return { state: listed.value.available ? "ready" : "unavailable", sessions };
}

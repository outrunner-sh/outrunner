"use client";

import { useCallback, useEffect, useState } from "react";

import { listLocalSessions, tauriCore, type LocalSession } from "@/lib/desktop/local-runtime";

export type LocalSessions =
  | { state: "loading"; sessions: LocalSession[] }
  /** Not the Outrunner Mac app: there are no local sessions to list here. */
  | { state: "unavailable"; sessions: LocalSession[] }
  | { state: "ready"; sessions: LocalSession[] }
  | { state: "error"; sessions: LocalSession[]; message: string };

/**
 * This Mac's local sessions, from the agent here. They are not in the shared
 * database, so every list of them is read from the Mac itself; re-read when the
 * window regains focus, since a session may have been made in another view.
 */
export function useLocalSessions(): LocalSessions & { refresh: () => void } {
  const [result, setResult] = useState<LocalSessions>({ state: "loading", sessions: [] });

  const refresh = useCallback(() => {
    if (!tauriCore()) {
      setResult({ state: "unavailable", sessions: [] });
      return;
    }
    listLocalSessions()
      .then((sessions) => setResult({ state: "ready", sessions }))
      .catch((error: unknown) =>
        setResult((prev) => ({
          state: "error",
          sessions: prev.sessions,
          message: error instanceof Error ? error.message : String(error),
        })),
      );
  }, []);

  useEffect(() => {
    // An external read (the agent), resolved in callbacks — not a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  return { ...result, refresh };
}

/** How a local session is labelled: what was asked, else the folder. */
export function localSessionLabel(session: LocalSession): string {
  return session.title || session.name;
}

"use client";

import { store, useStore } from "@/lib/client/store";
import { forgetCachedSession } from "@/lib/session/app-data-cache";
import { archiveSession } from "@/lib/session/archive-control";
import { patchListedSession, staleListedSessions } from "@/lib/session/listed-sessions";
import { dropRowAhead, patchRowAhead } from "@/lib/session/rows-ahead";

/**
 * Archiving without waiting: confirmed, the session shows as archived at
 * once — the dialog closes, the sidebar marks it — while the server saves its
 * work behind (lib/session/archive-session.ts), which can take a minute on a
 * large worktree. Should the server refuse, the session is shown as it was
 * again and the app says why ({@link useArchiveFailure}).
 *
 * What is shown is the status it will have, laid over the layout's row
 * (lib/session/rows-ahead.ts): "archiving" while the server works,
 * "archived" once it has, until the list is read again.
 */

/** An archive the server refused: which session, and why. */
export type ArchiveFailure = { id: string; title: string; message: string };
const FAILURE = store<ArchiveFailure | null>(null);

/** Archive `session`, showing it archived from now on. */
export function archiveInBackground(session: { id: string; title: string }): void {
  if (FAILURE.get()?.id === session.id) FAILURE.set(null);
  patchRowAhead(session.id, { status: "archiving" });
  patchListedSession(session.id, "archiving");
  // Until the list comes back, a reload must not show it as it was.
  forgetCachedSession(session.id);
  archiveSession(session.id).then(
    () => {
      patchRowAhead(session.id, { status: "archived" });
      patchListedSession(session.id, "archived");
    },
    (error: unknown) => {
      dropRowAhead(session.id, ["status"]);
      staleListedSessions();
      FAILURE.set({
        id: session.id,
        title: session.title,
        message: error instanceof Error ? error.message : "Could not archive this session.",
      });
    },
  );
}

/** The last archive the server refused, until dismissed or tried again. */
export function useArchiveFailure(): ArchiveFailure | null {
  return useStore(FAILURE, null);
}

export function dismissArchiveFailure(): void {
  FAILURE.set(null);
}

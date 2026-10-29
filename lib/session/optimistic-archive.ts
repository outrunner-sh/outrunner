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
 * again and the app says why ({@link useArchiveNotice}).
 *
 * What is shown is the status it will have, laid over the layout's row
 * (lib/session/rows-ahead.ts): "archiving" while the server works,
 * "archived" once it has, until the list is read again.
 */

/** An archive that failed, or completed without saving its files. */
export type ArchiveNotice = { id: string; title: string; message: string; kind: "error" | "unsaved" };
export const ARCHIVE_NOTICE = store<ArchiveNotice | null>(null);

/** Archive `session`, showing it archived from now on. */
export function archiveInBackground(session: { id: string; title: string }): Promise<void> {
  if (ARCHIVE_NOTICE.get()?.id === session.id) ARCHIVE_NOTICE.set(null);
  patchRowAhead(session.id, { status: "archiving" });
  patchListedSession(session.id, "archiving");
  // Until the list comes back, a reload must not show it as it was.
  forgetCachedSession(session.id);
  return archiveSession(session.id).then(
    (note) => {
      patchRowAhead(session.id, { status: "archived" });
      patchListedSession(session.id, "archived");
      // The dialog already closed: preserve the server's warning here when
      // an unreachable box meant its files could not be saved (#324).
      if (note) ARCHIVE_NOTICE.set({ ...session, message: note, kind: "unsaved" });
    },
    (error: unknown) => {
      dropRowAhead(session.id, ["status"]);
      staleListedSessions();
      ARCHIVE_NOTICE.set({
        id: session.id,
        title: session.title,
        kind: "error",
        message: error instanceof Error ? error.message : "Could not archive this session.",
      });
    },
  );
}

/** The last archive that needs attention, until acknowledged or retried. */
export function useArchiveNotice(): ArchiveNotice | null {
  return useStore(ARCHIVE_NOTICE, null);
}

export function dismissArchiveNotice(): void {
  ARCHIVE_NOTICE.set(null);
}

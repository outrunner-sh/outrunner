"use client";

import { store, useStore } from "@/lib/client/store";
import { forgetCachedSession } from "@/lib/session/app-data-cache";
import { archiveSession } from "@/lib/session/archive-control";
import { listedSessions, patchListedSession, staleListedSessions } from "@/lib/session/listed-sessions";
import { dropRowAhead, patchRowAhead } from "@/lib/session/rows-ahead";
import type { SessionListEntry } from "@/lib/session/session-list";

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
export function archiveInBackground(
  session: { id: string; title: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (ARCHIVE_NOTICE.get()?.id === session.id) ARCHIVE_NOTICE.set(null);
  patchRowAhead(session.id, { status: "archiving" });
  patchListedSession(session.id, "archiving");
  // Until the list comes back, a reload must not show it as it was.
  forgetCachedSession(session.id);
  return archiveSession(session.id, fetchImpl).then(
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

/**
 * Archiving with a moment to take it back — the sidebar row's Archive and the
 * session header's: one click, no dialog. The session leaves the lists at once
 * (shown "archiving"), a toast offers Undo for {@link UNDO_MS}, and only then
 * is the server asked ({@link archiveInBackground}). Undo before that asks
 * nothing: there is no box to bring back, no Snapshot to restore.
 *
 * One archive waits at a time: archiving another sends the one waiting at
 * once, so Undo always means the latest. Leaving the page sends it too
 * (`keepalive`), so a reload or a closed tab never quietly drops it.
 */
export const UNDO_MS = 5000;

export type PendingArchive = {
  id: string;
  title: string;
  /** Its status in the sessions list's kept answer, to put back on Undo. */
  listed: SessionListEntry["status"] | null;
  /** The page left to archive it (its own, open as it was archived), to go
   *  back to on Undo. */
  returnTo: string | null;
};
export const PENDING_ARCHIVE = store<PendingArchive | null>(null);
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function takePending(): PendingArchive | null {
  const pending = PENDING_ARCHIVE.get();
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  PENDING_ARCHIVE.set(null);
  return pending;
}

/** Archive `session` once Undo has passed; it is shown archived from now. */
export function archiveWithUndo(session: { id: string; title: string; returnTo?: string | null }): void {
  // A second click on the same row while its Undo shows changes nothing.
  if (PENDING_ARCHIVE.get()?.id === session.id) return;
  void sendPendingArchive();
  if (ARCHIVE_NOTICE.get()?.id === session.id) ARCHIVE_NOTICE.set(null);
  const listed = listedSessions()?.sessions.find((s) => s.id === session.id)?.status ?? null;
  patchRowAhead(session.id, { status: "archiving" });
  patchListedSession(session.id, "archiving");
  PENDING_ARCHIVE.set({ id: session.id, title: session.title, listed, returnTo: session.returnTo ?? null });
  pendingTimer = setTimeout(() => void sendPendingArchive(), UNDO_MS);
}

/** Take back the archive waiting, if any: shown as it was, nothing asked.
 *  Answers what was taken back, null when it had already been sent. */
export function undoArchive(): PendingArchive | null {
  const pending = takePending();
  if (!pending) return null;
  dropRowAhead(pending.id, ["status"]);
  if (pending.listed) patchListedSession(pending.id, pending.listed);
  return pending;
}

/** Send the archive waiting now, rather than once Undo passes. */
export function sendPendingArchive(fetchImpl: typeof fetch = fetch): Promise<void> {
  const pending = takePending();
  return pending ? archiveInBackground({ id: pending.id, title: pending.title }, fetchImpl) : Promise.resolve();
}

export function usePendingArchive(): PendingArchive | null {
  return useStore(PENDING_ARCHIVE, null);
}

// The page going away (reload, tab closed, another site) must not drop an
// archive the user asked for: sent with `keepalive`, which outlives the page.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void sendPendingArchive((input, init) => fetch(input, { ...init, keepalive: true }));
  });
}

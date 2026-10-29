"use client";

import { ConfirmSessionDialog } from "@/components/confirm-session-dialog";
import { Notice } from "@/components/ui/notice";
import { ARCHIVE_CONSEQUENCE } from "@/lib/session/archive-control";
import { archiveInBackground, dismissArchiveFailure, useArchiveFailure } from "@/lib/session/optimistic-archive";

/**
 * Confirm archiving a cloud session: what happens to its work and how it comes
 * back, then a click (archiving is undone by opening it, so no hold). The
 * dialog closes on the click: the session shows as archived at once while the
 * server saves its work behind (lib/session/optimistic-archive.ts), and the
 * app says so if it can't. `onArchived` runs at once too, to leave the session
 * if it is the one on screen: left open, its page would restore it again.
 */
export function ArchiveSessionDialog({
  session,
  onOpenChange,
  onArchived,
}: {
  /** The session to archive; null keeps the dialog closed. */
  session: { id: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
  onArchived: (id: string) => void;
}) {
  return (
    <ConfirmSessionDialog
      open={session !== null}
      title={`Archive “${session?.title ?? ""}”?`}
      description={ARCHIVE_CONSEQUENCE}
      busyLabel="Archiving"
      failure="Could not archive this session."
      confirm={(go) => (
        <button type="button" onClick={go} className="route-state-button is-primary">
          Archive session
        </button>
      )}
      run={async () => {
        if (session) archiveInBackground(session);
      }}
      onOpenChange={onOpenChange}
      onDone={() => {
        if (session) onArchived(session.id);
      }}
    />
  );
}

/**
 * An archive the server refused after the dialog had closed on it: said over
 * the app, wherever the user went, with the way back to the session (which
 * shows as it was again) to try once more.
 */
export function ArchiveFailureNotice() {
  const failure = useArchiveFailure();
  if (!failure) return null;
  return (
    <Notice
      className="fixed right-4 bottom-4 z-50 w-[min(420px,calc(100vw-32px))] shadow-lg"
      tone="error"
      title={`Couldn't archive “${failure.title}”`}
      detail={failure.message}
      actions={[
        { label: "Open session", href: `/workspaces/${failure.id}`, primary: true, onClick: dismissArchiveFailure },
        { label: "Dismiss", onClick: dismissArchiveFailure },
      ]}
    />
  );
}

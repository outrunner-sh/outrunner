"use client";

import { ConfirmSessionDialog } from "@/components/confirm-session-dialog";
import { Notice } from "@/components/ui/notice";
import { ARCHIVE_CONSEQUENCE } from "@/lib/session/archive-control";
import { archiveInBackground, dismissArchiveNotice, useArchiveNotice } from "@/lib/session/optimistic-archive";

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

/** An archive result that needs attention after its dialog has closed. */
export function ArchiveNotice() {
  const notice = useArchiveNotice();
  if (!notice) return null;
  const unsaved = notice.kind === "unsaved";
  return (
    <Notice
      className="fixed right-4 bottom-4 z-50 w-[min(420px,calc(100vw-32px))] shadow-lg"
      tone={unsaved ? "warning" : "error"}
      title={unsaved ? `Archived “${notice.title}” without its files` : `Couldn't archive “${notice.title}”`}
      detail={notice.message}
      actions={unsaved ? [{ label: "Done", primary: true, onClick: dismissArchiveNotice }] : [
        { label: "Open session", href: `/workspaces/${notice.id}`, primary: true, onClick: dismissArchiveNotice },
        { label: "Dismiss", onClick: dismissArchiveNotice },
      ]}
    />
  );
}

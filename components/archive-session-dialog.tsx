"use client";

import { ConfirmSessionDialog } from "@/components/confirm-session-dialog";
import { ARCHIVE_CONSEQUENCE, archiveSession } from "@/lib/session/archive-control";

/**
 * Confirm archiving a cloud session: what happens to its work and how it comes
 * back, then a click (archiving is undone by opening it, so no hold).
 * `onArchived` runs once it is archived, to re-read the list and, if it is
 * the session on screen, leave it: left open, its page would restore it again
 * at once.
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
      // Saving its work can take a minute on a large worktree.
      busyLabel="Archiving"
      failure="Could not archive this session."
      confirm={(go) => (
        <button type="button" onClick={go} className="route-state-button is-primary">
          Archive session
        </button>
      )}
      run={async () => {
        if (session) await archiveSession(session.id);
      }}
      onOpenChange={onOpenChange}
      onDone={() => {
        if (session) onArchived(session.id);
      }}
    />
  );
}

"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
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
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const confirm = async () => {
    if (!session) return;
    setState({ busy: true, error: null });
    try {
      await archiveSession(session.id);
      setState({ busy: false, error: null });
      onArchived(session.id);
      onOpenChange(false);
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "Could not archive this session." });
    }
  };

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        // Not while it is being archived: the outcome has to be seen.
        if (state.busy) return;
        if (!open) setState({ busy: false, error: null });
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-sm gap-5 bg-[#0d0d0d]" showClose={!state.busy}>
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">
            Archive “{session?.title}”?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">{ARCHIVE_CONSEQUENCE}</DialogDescription>
        </div>
        {state.error && (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {state.busy ? (
            // Saving its work can take a minute on a large worktree.
            <span role="status" className="inline-flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner /> Archiving
            </span>
          ) : (
            <>
              <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
                Cancel
              </button>
              <button type="button" onClick={() => void confirm()} className="route-state-button is-primary">
                Archive session
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

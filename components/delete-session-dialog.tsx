"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Spinner } from "@/components/ui/loaders";
import { deletionConsequence, type SessionDeletion } from "@/lib/nav/sidebar";
import { deleteSession } from "@/lib/session/delete-session";

/**
 * Confirm deleting a session: what goes and what stays, then a hold (not a
 * click) to do it. `onDeleted` runs once it is gone, for the caller to leave
 * the session if it is open and re-read the list.
 */
export function DeleteSessionDialog({
  session,
  onOpenChange,
  onDeleted,
}: {
  /** The session to delete; null keeps the dialog closed. */
  session: { id: string; title: string; deletion: SessionDeletion } | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (id: string) => void;
}) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const confirm = async () => {
    if (!session) return;
    setState({ busy: true, error: null });
    try {
      await deleteSession(session.id, session.deletion);
      setState({ busy: false, error: null });
      onDeleted(session.id);
      onOpenChange(false);
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "Could not delete this session." });
    }
  };

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        // Not while it is being deleted: the outcome has to be seen.
        if (state.busy) return;
        if (!open) setState({ busy: false, error: null });
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-sm gap-5 bg-[#0d0d0d]" showClose={!state.busy}>
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">
            Delete “{session?.title}”?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {session ? `${deletionConsequence(session.deletion)} This can't be undone.` : null}
          </DialogDescription>
        </div>
        {state.error && (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {state.busy ? (
            <span role="status" className="inline-flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner /> Deleting
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="route-state-button"
              >
                Cancel
              </button>
              <HoldToConfirm label="Delete session" onConfirm={() => void confirm()} />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

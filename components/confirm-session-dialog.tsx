"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";

/**
 * Confirm a change to a session (deleting it, archiving it): what it does,
 * then the control that does it. While it runs the dialog says so and can't
 * be closed, so the outcome is seen; a failure is said in it, for another try.
 * `run` throws with a sentence to show when it could not; `onDone` runs once
 * it did.
 */
export function ConfirmSessionDialog({
  open,
  title,
  description,
  busyLabel,
  failure,
  confirm,
  run,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  /** Shown beside the spinner while it runs, e.g. "Deleting". */
  busyLabel: string;
  /** Said when `run` throws something that isn't an Error. */
  failure: string;
  /** The control that confirms, given what to call. */
  confirm: (go: () => void) => React.ReactNode;
  run: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const go = async () => {
    setState({ busy: true, error: null });
    try {
      await run();
      setState({ busy: false, error: null });
      onDone();
      onOpenChange(false);
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : failure });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Not while it runs: the outcome has to be seen.
        if (state.busy) return;
        if (!next) setState({ busy: false, error: null });
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-sm gap-5 bg-[#0d0d0d]" showClose={!state.busy}>
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">{title}</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">{description}</DialogDescription>
        </div>
        {state.error && (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {state.busy ? (
            <span role="status" className="inline-flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner /> {busyLabel}
            </span>
          ) : (
            <>
              <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
                Cancel
              </button>
              {confirm(() => void go())}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
import { renameSession } from "@/lib/session/rename-session";
import { cleanTitle, titleProblem } from "@/lib/nav/session-title";

/** Rename a cloud session: its title, typed in place of the one it has. */
export function RenameSessionDialog({
  session,
  open,
  onOpenChange,
}: {
  session: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = cleanTitle(value);
  const problem = titleProblem(value);

  const save = async () => {
    if (!title || busy) return;
    if (title === session.title) return onOpenChange(false);
    setBusy(true);
    setError(null);
    try {
      await renameSession(session.id, title);
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't rename this session.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          setValue(session.title);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-sm gap-5" showClose={!busy} aria-describedby={undefined}>
        <DialogTitle className="text-[15px] font-medium leading-snug">Rename session</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-5"
        >
          <input
            autoFocus
            aria-label="Session title"
            value={value}
            aria-invalid={problem ? true : undefined}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="h-8 w-full rounded-md border border-border bg-input/30 px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {problem && <p className="text-[12px] text-muted-foreground">{problem}</p>}
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {busy ? (
              <span role="status" className="inline-flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner /> Renaming
              </span>
            ) : (
              <>
                <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
                  Cancel
                </button>
                <button type="submit" disabled={!title} className="route-state-button is-primary">
                  Rename
                </button>
              </>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

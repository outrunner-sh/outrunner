"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { type ActionStatus } from "@/components/ui/loading-button";

/*
 * The pieces every section of a project's settings page is made of
 * (components/project-settings.tsx and the sections kept in files of their
 * own), so each lays out, saves and deletes the same way.
 */

/** A section's title and what it holds, as the settings pages head theirs. */
export function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      <p className="text-[13px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/** Quiet sections on a shared surface, with dividers between related rows. */
export function Panel({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card/30">{children}</div>;
}

/** Delete a variable, a file or anything else of a project's: a trash button
 *  that turns into a hold, since what is deleted can't be had back. */
export function DeleteButton({ what, onDelete }: { what: string; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Delete ${what}`}
        title={`Delete ${what}`}
        className="text-muted-foreground"
        onClick={() => setConfirming(true)}
      >
        <Trash2 />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <HoldToConfirm label="Delete" onConfirm={onDelete} className="h-7 px-2.5 text-xs" />
      <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** A save's state: its button's, and why it failed. */
export function useSave() {
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  async function run<T>(send: () => Promise<T>): Promise<T | null> {
    setStatus("pending");
    setError(null);
    try {
      const result = await send();
      setStatus("success");
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
      setStatus("error");
      return null;
    }
  }
  return { status, error, run };
}

"use client";

import { GitMerge, ListOrdered } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import type { MergeAction, MergeOffer } from "@/lib/review/merge-plan";

/**
 * Merge, as the person clicking, at the commit they're looking at: by the
 * repository's rules (into the merge queue, where the base branch has one),
 * or, for someone GitHub lets past the rules, held down to "Bypass rules and
 * merge".
 */
export function MergeButton({ repo, number, headSha, offer }: { repo: string; number: number; headSha: string; offer: MergeOffer }) {
  const router = useRouter();
  const [busy, setBusy] = useState<MergeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Queued just now: shown until the page's refresh says how it stands, and
  // dropped once it does (the queue may have let it go since).
  const [queued, setQueued] = useState<number | null | undefined>(undefined);
  const standing = JSON.stringify(offer.primary);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server's word replaces the stand-in
    setQueued(undefined);
  }, [standing]);
  const merge = async (action: MergeAction) => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch("/api/review/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, headSha, action }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; queued?: boolean; position?: number | null };
      if (!response.ok) throw new Error(body.error ?? "Couldn't merge.");
      if (body.queued) setQueued(body.position ?? null);
      router.refresh();
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "Couldn't merge.");
    } finally {
      setBusy(null);
    }
  };
  const { primary } = offer;
  const position = queued !== undefined ? queued : primary.action === "queued" ? primary.position : undefined;
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1.5">
        {offer.bypass && (
          <HoldToConfirm
            label={busy === "bypass" ? "Merging…" : "Bypass rules and merge"}
            onConfirm={() => void merge("bypass")}
            disabled={busy !== null}
            className="h-8 rounded-md border border-destructive/50 px-3 text-[12px] text-destructive"
          />
        )}
        {position !== undefined ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-muted-foreground">
            <ListOrdered className="size-3.5" />
            In merge queue{position ? ` · #${position}` : ""}
          </span>
        ) : (
          primary.action !== "queued" && (
            <Button
              size="sm"
              onClick={() => void merge(primary.action)}
              disabled={busy !== null || primary.why !== null}
              title={primary.why ?? (primary.action === "queue" ? "Add to the merge queue, as you" : "Merge as you")}
            >
              {primary.action === "queue" ? <ListOrdered /> : <GitMerge />}
              {busy === primary.action ? (primary.action === "queue" ? "Queueing…" : "Merging…") : primary.label}
            </Button>
          )
        )}
      </span>
      {error && <span className="max-w-xs text-right text-[11px] text-destructive">{error}</span>}
    </span>
  );
}

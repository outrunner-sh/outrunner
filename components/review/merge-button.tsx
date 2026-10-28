"use client";

import { GitMerge } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Merge, as the person clicking, at the commit they're looking at. */
export function MergeButton({ repo, number, headSha, ready, why }: { repo: string; number: number; headSha: string; ready: boolean; why: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/review/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, headSha }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Couldn't merge.");
      router.refresh();
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "Couldn't merge.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={merge} disabled={busy || !ready} title={ready ? "Merge as you" : (why ?? undefined)}>
        <GitMerge />
        {busy ? "Merging…" : "Merge"}
      </Button>
      {error && <span className="max-w-xs text-right text-[11px] text-destructive">{error}</span>}
    </span>
  );
}

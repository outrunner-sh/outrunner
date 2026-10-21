"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { cn } from "@/lib/utils";

type SyncResponse = {
  synced?: number;
  discovered?: number;
  complete?: boolean;
  error?: string;
  reconnect?: boolean;
};

/** How long "Synced" stays on the button before it settles. */
const SETTLE_MS = 1400;

/**
 * Pull in the repositories the GitHub token can reach. The button says how it
 * went (LoadingButton, so it keeps its width), and the line beneath it — whose
 * space is held from the start, so nothing shifts — says what happened.
 */
export function ProjectsSyncButton({
  align = "end",
}: {
  align?: "start" | "center" | "end";
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [reconnect, setReconnect] = useState(false);

  useEffect(() => {
    if (status !== "success" && status !== "error") return;
    const t = setTimeout(() => setStatus("idle"), SETTLE_MS);
    return () => clearTimeout(t);
  }, [status]);

  async function sync() {
    setStatus("pending");
    // The last reason stays while this runs; its own answer replaces it.
    let response: Response;
    try {
      response = await fetch("/api/projects/sync", { method: "POST" });
    } catch {
      setStatus("error");
      setMessage({ text: "Couldn't reach Outrunner. Check your connection.", failed: true });
      setReconnect(false);
      return;
    }
    const result = (await response.json().catch(() => ({}))) as SyncResponse;
    if (!response.ok) {
      setStatus("error");
      setMessage({ text: result.error ?? "Couldn't sync repositories.", failed: true });
      setReconnect(result.reconnect === true);
      return;
    }
    const discovered = result.discovered ?? 0;
    setStatus("success");
    const synced = discovered === 1 ? "1 repository synchronized." : `${discovered} repositories synchronized.`;
    // GitHub had more than Outrunner reads in one go, or sent a record it
    // couldn't read: say so rather than imply this is everything.
    setMessage({
      text: result.complete === false ? `${synced} GitHub may have more.` : synced,
      failed: false,
    });
    setReconnect(false);
    router.refresh();
  }

  const alignment =
    align === "center"
      ? "items-center text-center"
      : align === "start"
        ? "items-start text-left"
        : "items-end text-right";

  return (
    <div className={cn("flex flex-col gap-1.5", alignment)}>
      <LoadingButton
        status={status}
        labels={{ idle: "Sync repositories", success: "Synced" }}
        icon={<RefreshCw />}
        onClick={() => void sync()}
      />
      {message?.failed ? (
        <InlineMessage className="min-h-4 max-w-64">
          {message.text}
          {reconnect && <GitHubReconnectLink />}
        </InlineMessage>
      ) : (
        <p aria-live="polite" className="text-muted-foreground min-h-4 max-w-64 text-xs">
          {message?.text}
        </p>
      )}
    </div>
  );
}

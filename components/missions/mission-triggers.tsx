"use client";

/**
 * A Mission's triggers (docs/missions.md, "Triggers"): the automations that
 * send it work (a schedule, a webhook, a watched Slack channel, Linear
 * issues), each with whether its owner has approved it, and their runs,
 * matches and skips included. Its owner approves or revokes; someone with
 * write on its project adds and changes them.
 */

import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { RecentRuns } from "@/components/automations";
import { buttonVariants } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import { type Automation, TRIGGER_LABELS } from "@/lib/automations/rules";
import type { AutomationRun } from "@/lib/db/automation-runs";
import { requestJson } from "@/lib/http/request-json";
import { cn } from "@/lib/utils";

export function MissionTriggers({
  mission,
  orgId,
  automations,
  runs,
  isOwner,
  canWrite,
  admin,
  byConnector,
}: {
  mission: { id: string; title: string };
  orgId: string;
  automations: Automation[];
  runs: AutomationRun[];
  isOwner: boolean;
  canWrite: boolean;
  /** An org admin: runs again from the history, as on the Automations page. */
  admin: boolean;
  byConnector: boolean;
}) {
  const router = useRouter();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approve = async (automation: Automation, approved: boolean) => {
    if (busy) return;
    setBusy(automation.id);
    setError(null);
    try {
      await requestJson(`/api/missions/${mission.id}/triggers/${automation.id}`, {
        method: "PATCH",
        body: { approved },
        fallback: "That didn't go through. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link
          href={`/workspaces/${mission.id}`}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {mission.title}
        </Link>
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-foreground">Triggers</h1>
            <p className="text-[13px] text-muted-foreground">
              What sends this Mission work besides you and its Slack channel. Each run becomes a request to it, never a session;
              its owner approves each trigger before it runs.
            </p>
          </div>
          {canWrite ? (
            <Link href={`/missions/${mission.id}/triggers/new`} className={cn(buttonVariants({ size: "sm" }), "shrink-0")}>
              <Plus className="size-3.5" /> New trigger
            </Link>
          ) : null}
        </header>

        {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}

        {automations.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No triggers yet.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {automations.map((automation) => {
              const approved = automation.target.kind === "mission" && automation.target.approved;
              return (
                <li key={automation.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/missions/${mission.id}/triggers/${automation.id}`} className="truncate text-[13px] font-medium text-foreground hover:underline">
                      {automation.name}
                    </Link>
                    <div className="truncate text-xs text-muted-foreground">
                      {automation.triggers.map((t) => TRIGGER_LABELS[t]).join(" · ")}
                      {automation.enabled ? "" : " · off"}
                    </div>
                  </div>
                  <span className={cn("shrink-0 text-xs", approved ? "text-positive" : "text-warning")}>
                    {approved ? "Approved" : "Waiting for the owner's approval"}
                  </span>
                  {isOwner ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void approve(automation, !approved)}
                      className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-white/[0.05] disabled:opacity-60"
                    >
                      {approved ? "Revoke" : "Approve"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <section className="space-y-2">
          <h2 className="text-[13px] font-medium text-foreground">Run history</h2>
          <RecentRuns orgId={orgId} runs={runs} kind={null} kinds={[]} now={now} admin={admin} byConnector={byConnector} />
        </section>
      </div>
    </div>
  );
}

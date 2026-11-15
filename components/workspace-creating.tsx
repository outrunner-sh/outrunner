"use client";

import { Check, Clock } from "lucide-react";
import { attachmentFiles, MessageAttachments } from "@/components/attachment-thumbnails";
import { Spinner, ThinkingIcon } from "@/components/ui/loaders";
import { useNow } from "@/hooks/use-now";
import type { ProvisionPhase } from "@/lib/runtime/types";
import type { FirstPrompt } from "@/lib/session/first-prompt";
import { cn } from "@/lib/utils";

export type SessionStartup = {
  startedAt: string;
  stalled: boolean;
  onDetails: () => void;
};

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** An honest queue echo, never an agent message or a delivery receipt. */
export function QueuedFirstPrompt({ first, startup }: { first: FirstPrompt; startup: SessionStartup }) {
  return (
    // Scrolls on its own: the conversation body around it clips.
    <div className="timeline-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-10 pb-16">
        <div>
          <div className="timeline-prompt">
            <MessageAttachments files={attachmentFiles(first.attachmentIds)} />
            {first.prompt.trim() && <div>{first.prompt.trim()}</div>}
          </div>
          <p className="mt-1 text-right text-[11px] text-muted-foreground">Queued · sends when ready</p>
        </div>
        <StartupStatus startup={startup} />
      </div>
    </div>
  );
}

/** Startup occupies the conversation's activity row; details open Session info. */
export function StartupStatus({ startup }: { startup: SessionStartup }) {
  const now = useNow(1000);
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1 text-[13px] text-muted-foreground">
      {startup.stalled ? <Clock className="size-3.5 shrink-0" /> : <ThinkingIcon />}
      <span>
        {startup.stalled ? "Startup is taking longer than expected" : "Starting your session"}
      </span>
      <span aria-hidden className="font-mono text-[11px] tabular-nums text-muted-foreground/70" suppressHydrationWarning>{elapsed(startup.startedAt, now)}</span>
      <button type="button" onClick={startup.onDetails} className="shrink-0 text-xs underline underline-offset-2">Session info</button>
    </div>
  );
}

const STAGES: { id: ProvisionPhase | "preparing"; label: string }[] = [
  { id: "preparing", label: "Preparing" },
  { id: "allocate", label: "Starting sandbox" },
  { id: "clone", label: "Preparing repository" },
  { id: "worktree", label: "Creating workspace" },
  { id: "secrets", label: "Configuring session" },
  { id: "health_check", label: "Starting agent" },
  { id: "claude_ready", label: "Ready" },
];

/** Technical startup details, only shown when Session info is opened. No
 * estimated completion time or time-based fabricated stage progression. */
export function WorkspaceCreating({ projectName, branch, phase, stalled, hasExistingComputer }: {
  projectName: string;
  branch: string;
  startedAt: string;
  phase: ProvisionPhase | null;
  hasExistingComputer: boolean;
  stalled?: React.ReactNode;
}) {
  const stages = hasExistingComputer ? STAGES.filter((s) => s.id !== "allocate") : STAGES;
  const active = Math.max(0, stages.findIndex((s) => s.id === phase));
  return (
    <section className="space-y-3 border-b border-border pb-4" aria-label="Startup details">
      <h3 className="text-sm font-medium">Session startup</h3>
      <p className="break-words text-xs text-muted-foreground">{projectName} · {branch}</p>
      <ol className="space-y-2 text-xs">
        {stages.map((stage, i) => (
          <li key={stage.id} className={cn("flex items-center gap-2", i !== active && "text-muted-foreground")}>
            {i < active ? <Check className="size-3" /> : i === active && !stalled ? <Spinner className="size-3" /> : <span className="size-3 rounded-full border border-current opacity-40" />}
            {stage.label}{i === active && <span className="sr-only"> · current step</span>}
          </li>
        ))}
      </ol>
      {stalled}
    </section>
  );
}

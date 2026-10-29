"use client";

import { Check, Clock, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import { attachmentFiles, MessageAttachments } from "@/components/attachment-thumbnails";
import { DotMatrix, Spinner } from "@/components/ui/loaders";
import type { ProvisionPhase } from "@/lib/runtime/types";
import type { FirstPrompt } from "@/lib/session/first-prompt";
import { cn } from "@/lib/utils";

/**
 * Provisioning progress, shown in a new session's chat while its box is set up.
 * Uses actual backend phases when available, with time-based fallback for
 * backwards compatibility.
 */

type Stage = { id: ProvisionPhase | "preparing"; label: string };

/** Full provisioning stages when creating a new Runtime Computer. */
const FULL_STAGES: Stage[] = [
  { id: "preparing", label: "Preparing" },
  { id: "allocate", label: "Provisioning sandbox" },
  { id: "clone", label: "Cloning repository" },
  { id: "worktree", label: "Creating workspace" },
  { id: "secrets", label: "Configuring session" },
  { id: "health_check", label: "Starting Claude" },
  { id: "claude_ready", label: "Ready" },
];

/** Quick start stages when Runtime Computer already exists. */
const QUICK_STAGES: Stage[] = [
  { id: "preparing", label: "Preparing" },
  { id: "clone", label: "Updating repository" },
  { id: "worktree", label: "Creating workspace" },
  { id: "secrets", label: "Configuring session" },
  { id: "health_check", label: "Starting Claude" },
  { id: "claude_ready", label: "Ready" },
];

/** Time-based fallback stages for when phase isn't available. */
const FALLBACK_STAGES = [
  { label: "Preparing", at: 0 },
  { label: "Provisioning sandbox", at: 3 },
  { label: "Installing agent", at: 12 },
  { label: "Cloning repository", at: 28 },
  { label: "Starting session", at: 38 },
  { label: "Finalizing setup", at: 46 },
] as const;

/** The first prompt, waiting for the box, as the message it will be: its
 *  files as thumbnails, its words clamped on whole lines. */
function QueuedPrompt({ first }: { first: FirstPrompt }) {
  const text = first.prompt.trim();
  return (
    <div className="flex flex-col items-stretch gap-1">
      <div className="timeline-prompt">
        <MessageAttachments files={attachmentFiles(first.attachmentIds)} />
        {text && <div className="line-clamp-6">{text}</div>}
      </div>
      <span className="text-muted-foreground flex items-center gap-1 self-end px-1 text-[11px]">
        <Clock className="size-3" aria-hidden />
        Sends when ready
      </span>
    </div>
  );
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function WorkspaceCreating({
  projectName,
  branch,
  startedAt,
  stalled,
  queued,
  phase,
  hasExistingComputer,
}: {
  projectName: string;
  branch: string;
  /** Set up for so long it may never finish: shown under the steps, and the
   *  current step stops turning. */
  stalled?: React.ReactNode;
  /** When setup began (the session's creation), so a session opened midway
   *  shows the time it has really taken. */
  startedAt: string;
  /** The first prompt waiting for the box, shown as the message it will be. */
  queued?: FirstPrompt | null;
  /** Current provisioning phase from the backend. */
  phase: ProvisionPhase | null;
  /** Whether there's already a Runtime Computer for this project. */
  hasExistingComputer: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.parse(startedAt);
    const tick = () =>
      setElapsed(Number.isNaN(started) ? 0 : Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Use real phases when available, otherwise fall back to time-based
  const useRealPhases = phase !== null;
  const stages = useRealPhases
    ? (hasExistingComputer ? QUICK_STAGES : FULL_STAGES)
    : FALLBACK_STAGES;

  let active = 0;
  if (useRealPhases) {
    // Find the index of the current phase
    const phaseStages = stages as Stage[];
    const phaseIndex = phaseStages.findIndex((s) => s.id === phase);
    active = phaseIndex >= 0 ? phaseIndex : 0;
  } else {
    // Time-based fallback
    const timeStages = stages as typeof FALLBACK_STAGES;
    for (let i = 0; i < timeStages.length; i += 1) {
      if (elapsed >= timeStages[i].at) active = i;
    }
  }

  // For quick start, show a shorter estimated time
  const estimateSeconds = useRealPhases && hasExistingComputer ? 10 : 45;

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-7">
        {queued && <QueuedPrompt first={queued} />}
        <DotMatrix rows={6} cols={10} />

        <div className="space-y-1.5">
          <h3 className="text-foreground text-lg font-medium tracking-tight">
            Creating workspace
          </h3>
          <p className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
            <GitBranch className="size-3.5" />
            {projectName} · {branch}
          </p>
        </div>

        <ol className="task-steps">
          {stages.map((stage, i) => {
            const state = i < active ? "done" : i === active ? "current" : "pending";
            return (
              <li key={stage.label} className={cn("task-step", `is-${state}`, stalled && state === "current" && "is-stalled")}>
                <span className="task-step-mark" aria-hidden>
                  {state === "done" ? (
                    <Check strokeWidth={3} />
                  ) : state === "current" ? (
                    stalled ? <Clock /> : <Spinner />
                  ) : (
                    <span className="task-step-dot" />
                  )}
                </span>
                <span>{stage.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="text-muted-foreground flex items-center justify-between font-mono text-xs tabular-nums">
          <span role="status">
            {stages[active].label}, step {active + 1} of {stages.length}
          </span>
          <span>
            {clock(elapsed)} <span className="text-muted-foreground/60">/ ~{estimateSeconds}s</span>
          </span>
        </div>

        {stalled}
      </div>
    </div>
  );
}

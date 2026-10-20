"use client";

import { Check, Clock, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import { DotMatrix, Spinner } from "@/components/ui/loaders";
import type { FirstPrompt } from "@/lib/session/first-prompt";
import { cn } from "@/lib/utils";

/**
 * Provisioning progress, shown in a new session's chat while its box is set up.
 * Cloud provisioning (sandbox → agent → clone → session) takes tens of seconds,
 * so instead of a bare spinner we walk a staged checklist on a time estimate,
 * drawn as interior.dev's Task Steps: done steps ticked, the current one
 * turning, the rest waiting, and one line naming the step.
 * The final stage HOLDS (never auto-completes) until the session's setup ends
 * and its page attaches — we never claim "done" before the box is ready.
 */

/** Ordered provisioning stages with the elapsed second each becomes active. */
const STAGES = [
  { label: "Preparing", at: 0 },
  { label: "Provisioning sandbox", at: 3 },
  { label: "Installing agent", at: 12 },
  { label: "Cloning repository", at: 28 },
  { label: "Starting session", at: 38 },
  { label: "Finalizing setup", at: 46 },
] as const;

const ESTIMATE_SECONDS = 45;

function QueuedPrompt({ first }: { first: FirstPrompt }) {
  const files = first.attachmentIds.length;
  const text = first.prompt.trim() || `${files} ${files === 1 ? "file" : "files"}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="line-clamp-4 max-w-[90%] whitespace-pre-wrap break-words rounded-3xl bg-foreground/[0.07] px-4 py-2 text-[0.8125rem] leading-relaxed text-foreground">
        {text}
      </div>
      <span className="text-muted-foreground flex items-center gap-1 px-2 text-[11px]">
        <Clock className="size-3" aria-hidden />
        Sends when ready{first.prompt.trim() && files > 0 ? ` · ${files} ${files === 1 ? "file" : "files"}` : ""}
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

  // The active stage is the last one whose threshold we've passed, capped at the
  // final stage so we hold there until provisioning actually completes.
  let active = 0;
  for (let i = 0; i < STAGES.length; i += 1) {
    if (elapsed >= STAGES[i].at) active = i;
  }

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
          {STAGES.map((stage, i) => {
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
            {STAGES[active].label}, step {active + 1} of {STAGES.length}
          </span>
          <span>
            {clock(elapsed)} <span className="text-muted-foreground/60">/ ~{ESTIMATE_SECONDS}s</span>
          </span>
        </div>

        {stalled}
      </div>
    </div>
  );
}

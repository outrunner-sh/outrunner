"use client";

import { Check, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import { DotMatrix, Spinner } from "@/components/ui/loaders";

/**
 * Full-screen provisioning progress shown while a workspace is being created.
 * Cloud provisioning (sandbox → agent → clone → session) takes tens of seconds,
 * so instead of a bare spinner we walk a staged checklist on a time estimate,
 * drawn as interior.dev's Task Steps: done steps ticked, the current one
 * turning, the rest waiting, and one line naming the step.
 * The final stage HOLDS (never auto-completes) until the create request resolves
 * and the caller navigates away — we never claim "done" before the box is ready.
 */

/** A stage of the timed estimate: its label and the elapsed second it
 *  becomes the current one. */
export type CreatingStage = { label: string; at: number };

/** Ordered provisioning stages with the elapsed second each becomes active. */
const STAGES: readonly CreatingStage[] = [
  { label: "Preparing", at: 0 },
  { label: "Provisioning sandbox", at: 3 },
  { label: "Installing agent", at: 12 },
  { label: "Cloning repository", at: 28 },
  { label: "Starting session", at: 38 },
  { label: "Finalizing setup", at: 46 },
];

const ESTIMATE_SECONDS = 45;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function WorkspaceCreating({
  projectName,
  branch,
  title = "Creating workspace",
  before = [],
  stages = STAGES,
  estimateSeconds = ESTIMATE_SECONDS,
}: {
  projectName: string;
  branch: string;
  title?: string;
  /** Steps that come first and are ticked as they really finish, not on the
   *  estimate: the timed stages start once they are all done. */
  before?: { label: string; done: boolean }[];
  stages?: readonly CreatingStage[];
  estimateSeconds?: number;
}) {
  const [elapsed, setElapsed] = useState(0);
  // When the steps before were all done: the timed stages count from then.
  const [timedFrom, setTimedFrom] = useState<number | null>(null);
  const beforeDone = before.every((step) => step.done);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (beforeDone && timedFrom === null) setTimedFrom(elapsed);
  }, [beforeDone, timedFrom, elapsed]);

  // The active stage is the last one whose threshold we've passed, capped at the
  // final stage so we hold there until provisioning actually completes. While
  // a step before is unfinished, that step is the active one.
  const steps = [...before.map((step) => step.label), ...stages.map((stage) => stage.label)];
  let active = before.findIndex((step) => !step.done);
  if (active < 0) {
    const timed = timedFrom === null ? 0 : elapsed - timedFrom;
    active = before.length;
    for (let i = 0; i < stages.length; i += 1) {
      if (timed >= stages[i].at) active = before.length + i;
    }
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-7">
        <DotMatrix rows={6} cols={10} />

        <div className="space-y-1.5">
          <h1 className="text-foreground text-lg font-medium tracking-tight">
            {title}
          </h1>
          <p className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
            <GitBranch className="size-3.5" />
            {projectName} · {branch}
          </p>
        </div>

        <ol className="task-steps">
          {steps.map((label, i) => {
            const state = i < active ? "done" : i === active ? "current" : "pending";
            return (
              <li key={label} className={`task-step is-${state}`}>
                <span className="task-step-mark" aria-hidden>
                  {state === "done" ? (
                    <Check strokeWidth={3} />
                  ) : state === "current" ? (
                    <Spinner />
                  ) : (
                    <span className="task-step-dot" />
                  )}
                </span>
                <span>{label}</span>
              </li>
            );
          })}
        </ol>

        <div className="text-muted-foreground flex items-center justify-between gap-3 font-mono text-xs tabular-nums">
          {/* A long step name gives way, never the clock. */}
          <span role="status" className="min-w-0 truncate">
            {steps[active]}, step {active + 1} of {steps.length}
          </span>
          <span className="shrink-0">
            {clock(elapsed)} <span className="text-muted-foreground/60">/ ~{estimateSeconds}s</span>
          </span>
        </div>
      </div>
    </div>
  );
}

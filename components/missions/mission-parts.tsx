"use client";

/**
 * The small parts the Missions UI is made of (the sidebar's section, the
 * Runners pane, the header): a Mission's icon with its status, a Runner's
 * state, and a pull request's chip, its checks on hover.
 */

import { AlertTriangle, Check, CircleDashed, GitMerge, GitPullRequest, Loader, Rocket, X } from "lucide-react";

import { missionIcon } from "@/lib/missions/icons";
import type { RunnerState } from "@/lib/missions/rules";
import { MISSION_STATUS_LABEL, type MissionStatus, type RunnerGroup, type RunnerPullView } from "@/lib/missions/view";
import { cn } from "@/lib/utils";

/** Each status's colour: orange is the user's to act on, green ready,
 *  a soft pulse at work, grey at rest. */
export const STATUS_DOT: Record<MissionStatus, string> = {
  needs_you: "bg-brand",
  working: "bg-[#c9c9c9] mission-pulse",
  ready: "bg-[#3fb950]",
  idle: "bg-[#5a5a5a]",
};

export function StatusDot({ status, className }: { status: MissionStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={MISSION_STATUS_LABEL[status]}
      title={MISSION_STATUS_LABEL[status]}
      className={cn("inline-block size-[7px] shrink-0 rounded-full transition-colors duration-300", STATUS_DOT[status], className)}
    />
  );
}

/** The Mission's icon in its tile, its status a dot at the corner. */
export function MissionGlyph({
  id,
  icon,
  status,
  size = "sm",
}: {
  id: string;
  icon: string | null;
  status?: MissionStatus;
  size?: "sm" | "md";
}) {
  const { Icon, label } = missionIcon(id, icon);
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center rounded-[5px] border border-white/10 bg-white/[0.04] text-[#d6d6d6]",
        size === "sm" ? "size-[18px]" : "size-7 rounded-md",
      )}
      aria-hidden={status ? undefined : true}
      title={label}
    >
      <Icon className={size === "sm" ? "size-[11px]" : "size-4"} strokeWidth={1.75} />
      {status && (
        <span className="absolute -right-[3px] -bottom-[3px] grid place-items-center rounded-full bg-sidebar p-[2px]">
          <StatusDot status={status} className="size-[6px]" />
        </span>
      )}
    </span>
  );
}

const GROUP_GLYPH: Record<RunnerGroup, { Icon: typeof Check; className: string; label: string }> = {
  needs_you: { Icon: AlertTriangle, className: "text-brand", label: "Needs you" },
  ready_to_merge: { Icon: GitMerge, className: "text-[#3fb950]", label: "Ready to merge" },
  ready_to_review: { Icon: GitPullRequest, className: "text-[#3fb950]", label: "Ready to review" },
  working: { Icon: Loader, className: "text-[#bdbdbd]", label: "Working" },
  shipping: { Icon: Rocket, className: "text-[#a78bfa]", label: "Shipping" },
  done: { Icon: Check, className: "text-[#6f6f6f]", label: "Done" },
};

/** A Runner's state as one small glyph: its group, and at work a turning one. */
export function RunnerGlyph({ group, state, className }: { group: RunnerGroup; state: RunnerState; className?: string }) {
  if (group === "working" && state !== "working" && state !== "setting_up") {
    return (
      <span role="img" aria-label={state === "asleep" ? "Asleep" : "Idle"} title={state === "asleep" ? "Asleep" : "Idle"}>
        <CircleDashed className={cn("size-3.5 shrink-0 text-[#6f6f6f]", className)} />
      </span>
    );
  }
  const { Icon, className: tone, label } = GROUP_GLYPH[group];
  const turning = group === "working";
  return (
    <span role="img" aria-label={turning && state === "setting_up" ? "Setting up" : label} title={turning && state === "setting_up" ? "Setting up" : label}>
      <Icon className={cn("size-3.5 shrink-0", tone, turning && "animate-[spin_2.4s_linear_infinite]", className)} />
    </span>
  );
}

/** A pull request's checks in a word: all passed, some failed, or running. */
export function checksTone(pr: Pick<RunnerPullView, "checks">): "pass" | "fail" | "pending" | "none" {
  if (pr.checks.length === 0) return "none";
  if (pr.checks.some((c) => c.status === "completed" && c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion))) return "fail";
  if (pr.checks.some((c) => c.status !== "completed")) return "pending";
  return "pass";
}

function CheckIcon({ tone, className }: { tone: ReturnType<typeof checksTone>; className?: string }) {
  if (tone === "pass") return <Check className={cn("size-3 text-[#3fb950]", className)} strokeWidth={2.5} />;
  if (tone === "fail") return <X className={cn("size-3 text-[#f85149]", className)} strokeWidth={2.5} />;
  if (tone === "pending") return <span className={cn("size-[7px] rounded-full bg-[#d29922] mission-pulse", className)} />;
  return null;
}

/**
 * A pull request as a chip: its number and how its checks went, linking to it.
 * Hovered or focused, it lists each check.
 */
export function PullRequestChip({ pr, showTitle = false }: { pr: RunnerPullView; showTitle?: boolean }) {
  const tone = checksTone(pr);
  const merged = pr.state === "merged";
  const closed = pr.state === "closed";
  return (
    <span className="group/pr relative inline-flex min-w-0 items-center">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "inline-flex h-[18px] min-w-0 items-center gap-1 rounded-[4px] border px-1.5 text-[11px] tabular-nums transition-colors",
          merged
            ? "border-[#a78bfa]/30 text-[#c4b5fd]"
            : closed
              ? "border-white/10 text-[#7a7a7a] line-through"
              : "border-white/10 text-[#cfcfcf] hover:border-white/25 hover:text-white",
        )}
        aria-label={`Pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""}, checks ${tone === "none" ? "not reported" : tone === "pass" ? "passing" : tone === "fail" ? "failing" : "running"}`}
      >
        {merged ? <GitMerge className="size-3" /> : <GitPullRequest className="size-3 text-[#8f8f8f]" />}
        <span>#{pr.number}</span>
        {showTitle && pr.title && <span className="min-w-0 truncate text-[#9a9a9a]">{pr.title}</span>}
        {!merged && !closed && <CheckIcon tone={tone} />}
      </a>
      {pr.checks.length > 0 && (
        <span
          role="tooltip"
          className="pointer-events-none invisible absolute top-[calc(100%+6px)] left-0 z-50 w-64 translate-y-1 rounded-md border border-white/10 bg-[#1b1b1b] p-2 opacity-0 shadow-xl shadow-black/40 transition-all duration-150 group-focus-within/pr:visible group-focus-within/pr:translate-y-0 group-focus-within/pr:opacity-100 group-hover/pr:visible group-hover/pr:translate-y-0 group-hover/pr:opacity-100"
        >
          <span className="mb-1.5 flex items-center justify-between px-1 text-[11px] text-[#8f8f8f]">
            <span>Checks</span>
            <span className="tabular-nums">
              {pr.checks.filter((c) => c.conclusion === "success").length}/{pr.checks.length} passed
            </span>
          </span>
          <span className="flex max-h-56 flex-col gap-px overflow-hidden">
            {pr.checks.slice(0, 12).map((c, i) => {
              const t = checksTone({ checks: [c] });
              return (
                <span key={`${c.name}-${i}`} className="flex items-center gap-2 rounded px-1 py-[3px] text-[12px] text-[#d6d6d6]">
                  <span className="grid w-3 place-items-center">
                    <CheckIcon tone={t} />
                  </span>
                  <span className="min-w-0 truncate">{c.name}</span>
                </span>
              );
            })}
            {pr.checks.length > 12 && <span className="px-1 pt-1 text-[11px] text-[#7a7a7a]">and {pr.checks.length - 12} more</span>}
          </span>
        </span>
      )}
    </span>
  );
}

/** +12 −3, as a diff's size. */
export function DiffSize({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null && deletions === null) return null;
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-[#3fb950]">+{additions ?? 0}</span> <span className="text-[#f85149]">−{deletions ?? 0}</span>
    </span>
  );
}

"use client";

/**
 * The small parts the Missions UI is made of (the sidebar's section, the
 * Ships pane, the header): a Mission's icon with its status, a Ship's
 * state, and a pull request's chip, its checks on hover.
 */

import { AlertTriangle, Check, CircleDashed, GitMerge, GitPullRequest, Loader, Rocket, X } from "lucide-react";

import { StandingMark } from "@/components/sidebar-status";
import { missionIcon } from "@/lib/missions/icons";
import type { RunnerState } from "@/lib/missions/rules";
import { MISSION_STATUS_LABEL, type MissionStatus, type RunnerGroup, type RunnerPullView } from "@/lib/missions/view";
import type { SessionStanding } from "@/lib/session/standing";
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

/**
 * A Ship's state as one small glyph. Where it stands as any session does
 * (at work, or needing a person: a question, a plan, secrets, an error),
 * the sidebar's own mark (StandingMark), so a Ship reads like every other
 * session; where it's the Mission's own (a pull request ready to merge or
 * review, shipping, one needing attention), a glyph of its group's.
 */
export function RunnerGlyph({
  group,
  state,
  standing,
  className,
}: {
  group: RunnerGroup;
  state: RunnerState;
  standing?: SessionStanding | null;
  className?: string;
}) {
  if (standing && (group === "working" || (group === "needs_you" && standing.standing === "needs_you"))) {
    return <StandingMark standing={standing} className={className} />;
  }
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

/** A reply the user hasn't seen, as the sidebar marks it. */
export function UnreadDot({ standing }: { standing?: SessionStanding | null }) {
  if (!standing?.unread) return null;
  return <span role="img" aria-label="New reply" title="A reply you haven't seen" className="size-1.5 shrink-0 rounded-full bg-sky-400" />;
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
export function PullRequestChip({
  pr,
  showTitle = false,
  link = true,
  compact = false,
}: {
  pr: RunnerPullView;
  showTitle?: boolean;
  /** A link to it; off inside a row that's a link itself (a link can't hold
   *  another), where it's only a chip. */
  link?: boolean;
  /** The sidebar only needs an icon once a PR has merged. */
  compact?: boolean;
}) {
  const tone = checksTone(pr);
  const merged = pr.state === "merged";
  const closed = pr.state === "closed";
  const iconOnly = compact && merged;
  const label = `${merged ? "Merged pull request" : closed ? "Closed pull request" : "Pull request"} ${pr.repo}#${pr.number}${pr.title ? `: ${pr.title}` : ""}`;
  return (
    <span className="group/pr relative inline-flex min-w-0 items-center">
      <Chip
        {...(link ? { href: pr.url, target: "_blank", rel: "noreferrer", onClick: (e: React.MouseEvent) => e.stopPropagation() } : {})}
        className={cn(
          "inline-flex h-[18px] min-w-0 items-center gap-1 text-[11px] tabular-nums transition-colors",
          iconOnly ? "justify-center px-0.5" : "rounded-[4px] border px-1.5",
          merged
            ? "border-merged/30 text-merged"
            : closed
              ? "border-white/10 text-[#7a7a7a] line-through"
              : "border-white/10 text-[#cfcfcf] hover:border-white/25 hover:text-white",
        )}
        role={iconOnly && !link ? "img" : undefined}
        title={label}
        aria-label={`${label}, checks ${tone === "none" ? "not reported" : tone === "pass" ? "passing" : tone === "fail" ? "failing" : "running"}`}
      >
        {merged ? <GitMerge aria-hidden className="size-3.5" /> : <GitPullRequest aria-hidden className="size-3 text-muted-foreground" />}
        {!iconOnly && <span>#{pr.number}</span>}
        {showTitle && pr.title && <span className="min-w-0 truncate text-[#9a9a9a]">{pr.title}</span>}
        {!merged && !closed && <CheckIcon tone={tone} />}
      </Chip>
      {pr.checks.length > 0 && (
        <span
          role="tooltip"
          className="pointer-events-none invisible absolute top-[calc(100%+6px)] left-0 z-50 w-64 translate-y-1 rounded-md border border-border bg-popover p-2 opacity-0 shadow-xl shadow-black/40 transition-all duration-150 group-focus-within/pr:visible group-focus-within/pr:translate-y-0 group-focus-within/pr:opacity-100 group-hover/pr:visible group-hover/pr:translate-y-0 group-hover/pr:opacity-100"
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

/** A link when given an href, else a plain span. */
function Chip({ href, ...props }: React.ComponentProps<"a">) {
  return href ? <a href={href} {...props} /> : <span {...(props as React.ComponentProps<"span">)} />;
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

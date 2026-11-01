"use client";

import Link, { useLinkStatus } from "next/link";
import {
  Archive,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  Copy,
  CircleCheck,
  CircleDashed,
  Ellipsis,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Pencil,
  Pin,
  PinOff,
  Slack,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { RenameSessionDialog } from "@/components/rename-session-dialog";
import { Spinner, ThinkingIcon } from "@/components/ui/loaders";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { markSession } from "@/hooks/use-standings";
import { useSkeletonSwap } from "@/hooks/use-skeleton-swap";
import { relativeTime, type SessionDeletion, type SidebarSession } from "@/lib/nav/sidebar";
import { shownRows, type StatusRow, type StatusSection } from "@/lib/nav/status-groups";
import type { WorkspacePullRequest } from "@/lib/runtime/types";
import { isStanding, REASON_LABEL, STANDING_LABEL, MOVABLE_STANDINGS, type SessionStanding } from "@/lib/session/standing";
import { cancelWarmOnRest, warmOnRest, warmSession } from "@/lib/session/warm-session";
import { cn } from "@/lib/utils";

/**
 * The sidebar's sessions by where they stand (lib/nav/status-groups.ts): a
 * heading for each group, folded with its chevron like a project, and its
 * sessions, each with a mark for its standing, a dot for a reply not seen,
 * and a menu to rename, pin, move or delete it, copy its branch or open its
 * pull request.
 */
export function StatusSections({
  sections,
  pullRequests,
  active,
  now,
  folded,
  searching,
  onToggle,
  onDelete,
}: {
  sections: StatusSection[];
  /** The pull request each cloud session shows, keyed by workspace id. */
  pullRequests: Record<string, WorkspacePullRequest>;
  active?: string;
  now: number;
  /** Fold keys: `status:<section key>`. */
  folded: string[];
  searching: boolean;
  onToggle: (key: string) => void;
  onDelete: (session: { id: string; title: string; deletion: SessionDeletion }) => void;
}) {
  // Sections opened past their first few rows, for this visit.
  const [expanded, setExpanded] = useState<string[]>([]);
  return (
    <div className="space-y-3">
      {sections.map((section) => {
        const foldKey = `status:${section.key}`;
        const isFolded = folded.includes(foldKey);
        const { rows, hidden } = shownRows(section, {
          folded: isFolded,
          expanded: expanded.includes(section.key),
          searching,
          active,
        });
        return (
          <div key={section.key}>
            <button
              type="button"
              onClick={() => onToggle(foldKey)}
              aria-expanded={!isFolded}
              className="group/ws flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="min-w-0 truncate">{section.label}</span>
              <span className="tabular-nums text-muted-foreground/70">{section.rows.length}</span>
              <ChevronRight
                aria-hidden
                className={cn(
                  "ml-auto size-3.5 shrink-0 transition",
                  !isFolded && "rotate-90 opacity-0 group-hover/ws:opacity-100 group-focus-visible/ws:opacity-100",
                )}
              />
            </button>
            {rows.map((row) => (
              <StatusRowLink
                key={row.id}
                row={row}
                pullRequest={pullRequests[row.id]}
                active={row.id === active}
                now={now}
                onDelete={onDelete}
              />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((keys) => [...keys, section.key])}
                className="w-full rounded-md py-1 pl-[32px] pr-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                Show {hidden} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusRowLink({
  row,
  pullRequest,
  active,
  now,
  onDelete,
}: {
  row: StatusRow;
  pullRequest: WorkspacePullRequest | undefined;
  active: boolean;
  now: number;
  onDelete: (session: { id: string; title: string; deletion: SessionDeletion }) => void;
}) {
  const { standing } = row;
  const merged = pullRequest?.state === "merged";
  // As the project view's rows: a cloud session warms as the pointer rests.
  const warm = !active && !row.local;
  return (
    <div className="group/row relative">
      <Link
        href={row.href}
        onPointerEnter={warm ? () => warmOnRest(row.id) : undefined}
        onPointerLeave={warm ? cancelWarmOnRest : undefined}
        onFocus={warm ? () => warmSession(row.id) : undefined}
        title={rowTooltip(row)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md py-1 pl-2 pr-2 text-[13px] transition-colors group-hover/row:pr-8 group-focus-within/row:pr-8",
          active
            ? "bg-accent text-foreground"
            : standing.unread
              ? "text-foreground hover:bg-accent/60"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <StandingMark standing={standing} merged={merged} />
        <span className={cn("min-w-0 flex-1 truncate", standing.unread && "font-medium")}>{row.title}</span>
        {standing.unread && (
          <span aria-label="New reply" title="A reply you haven't seen" className="size-1.5 shrink-0 rounded-full bg-sky-400" />
        )}
        {standing.pinned && <Pin aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />}
        {row.slackThreadUrl && <Slack aria-label="From Slack" className="size-3 shrink-0 text-muted-foreground" />}
        {row.archived && <Archive aria-label="Archived" className="size-3 shrink-0 text-muted-foreground" />}
        <RowTail at={row.at} now={now} hideOnHover />
      </Link>
      <SessionMenu
        session={row}
        markable={row.markable}
        standing={standing}
        pullRequestUrl={pullRequest?.url}
        onDelete={onDelete}
        className="absolute right-1 top-1/2 -translate-y-1/2"
      />
    </div>
  );
}

function rowTooltip(row: StatusRow): string {
  const parts = [row.title, row.local ? `${row.project} · this Mac` : row.project];
  const { standing } = row;
  if (standing.reason) parts.push(REASON_LABEL[standing.reason]);
  else if (standing.moved) parts.push(`Moved to ${STANDING_LABEL[standing.standing]}`);
  return parts.join("\n");
}

/** A session's standing at a glance, in the space a project row's icon has. */
export function StandingMark({
  standing,
  merged = false,
  className,
}: {
  standing: SessionStanding;
  /** A Done session whose pull request was merged. */
  merged?: boolean;
  className?: string;
}) {
  const label = standing.reason ? REASON_LABEL[standing.reason] : STANDING_LABEL[standing.standing];
  const box = cn("size-3.5 shrink-0", className);
  switch (standing.standing) {
    case "needs_you":
      return <CircleAlert aria-label={label} className={cn(box, "text-amber-400")} />;
    case "working":
      return <ThinkingIcon label={label} className={box} />;
    case "in_review":
      return <GitPullRequest aria-label={label} className={cn(box, "text-emerald-400")} />;
    case "done":
      return merged ? (
        <GitMerge aria-label="Merged pull request" className={cn(box, "text-[#c4b5fd]")} />
      ) : (
        <CircleCheck aria-label={label} className={cn(box, "text-muted-foreground")} />
      );
    case "backlog":
      return <CircleDashed aria-label={label} className={cn(box, "text-muted-foreground/70")} />;
  }
}

/**
 * A session's menu: Rename, Pin, Move to (a group by hand, or back to
 * Automatic), Copy branch, Open pull request and Delete, each where it
 * applies. Shown on the row's hover, as its buttons were. (Archive was
 * replaced by Delete: 246c9389.)
 */
export function SessionMenu({
  session,
  markable,
  standing,
  pullRequestUrl,
  onDelete,
  className,
}: {
  session: Pick<SidebarSession, "id" | "title" | "deletion" | "branch">;
  /** A cloud session: Rename, Pin and Move to are offered. */
  markable: boolean;
  standing: SessionStanding | undefined;
  /** Its pull request on GitHub, when it has one. */
  pullRequestUrl?: string;
  onDelete: (session: { id: string; title: string; deletion: SessionDeletion }) => void;
  className?: string;
}) {
  const [renaming, setRenaming] = useState(false);
  // Copy branch says it copied, the menu kept open for it, as Copy does elsewhere.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const { deletion, branch } = session;
  if (!markable && !deletion && !branch) return null;
  const mark = (change: Parameters<typeof markSession>[1]) => {
    void markSession(session.id, change).catch((error: unknown) => {
      console.error(`Couldn't change ${session.id}'s marks`, error);
    });
  };
  const copyBranch = () => {
    navigator.clipboard.writeText(branch).then(
      () => setCopied(true),
      (error: unknown) => console.error(`Couldn't copy ${session.id}'s branch`, error),
    );
  };
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More for ${session.title}`}
        title="More"
        className={cn(
          "rounded p-1 text-muted-foreground opacity-0 outline-none transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/row:opacity-100",
          className,
        )}
      >
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {markable && (
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
        )}
        {markable && standing && (
          <>
            <DropdownMenuItem onSelect={() => mark({ pinned: !standing.pinned })}>
              {standing.pinned ? <PinOff /> : <Pin />}
              {standing.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Circle />
                Move to
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={standing.moved ? standing.standing : "auto"}
                  onValueChange={(value) => mark({ movedTo: isStanding(value) ? value : null })}
                >
                  {/* Where the server puts it, as its agent and pull request go. */}
                  <DropdownMenuRadioItem value="auto">Automatic</DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {MOVABLE_STANDINGS.map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>
                      {STANDING_LABEL[s]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        {(branch || pullRequestUrl) && <DropdownMenuSeparator />}
        {branch && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              copyBranch();
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy branch"}
          </DropdownMenuItem>
        )}
        {pullRequestUrl && (
          <DropdownMenuItem asChild>
            <a href={pullRequestUrl} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open pull request
            </a>
          </DropdownMenuItem>
        )}
        {(markable || branch) && deletion && <DropdownMenuSeparator />}
        {deletion && (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onDelete({ id: session.id, title: session.title, deletion })}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {markable && <RenameSessionDialog session={session} open={renaming} onOpenChange={setRenaming} />}
    </>
  );
}

/** A session row's right end: when it was last active, or, from the click until
 *  its page arrives, a spinner in the same box (useLinkStatus), so a click in
 *  the sidebar always answers. The answer waits out the skeleton rule
 *  (lib/session/skeleton-swap.ts): a page that arrives within
 *  SKELETON_DELAY_MS shows no spinner at all, a flash being worse than
 *  nothing, and one that has shown is held its minimum so it cannot blink.
 *  Steps aside on hover for the row's menu. */
export function RowTail({ at, now, hideOnHover }: { at: string; now: number; hideOnHover: boolean }) {
  const { pending } = useLinkStatus();
  // The load is over once the click's navigation lands, so not pending is
  // ready, exactly as a skeleton's content is (components/ui/skeleton-swap.tsx).
  const showSpinner = useSkeletonSwap(!pending);
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center",
        // Under the row's menu button while it shows, or its menu is open.
        hideOnHover && "group-hover/row:invisible group-has-[[data-state=open]]/row:invisible",
      )}
    >
      {/* The server's clock and the browser's differ by the render delay,
          which can tip "59m" into "1h": not a real mismatch. */}
      <time
        dateTime={at}
        suppressHydrationWarning
        className={cn("col-start-1 row-start-1 text-xs text-muted-foreground", showSpinner && "invisible")}
      >
        {relativeTime(at, now)}
      </time>
      {/* Both share the cell, so the swap moves nothing around them. */}
      {showSpinner && <Spinner label="Opening" className="col-start-1 row-start-1 size-3 text-muted-foreground" />}
    </span>
  );
}

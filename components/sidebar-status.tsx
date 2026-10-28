"use client";

import Link, { useLinkStatus } from "next/link";
import {
  Archive,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Ellipsis,
  GitPullRequest,
  Pin,
  PinOff,
  Slack,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Spinner } from "@/components/ui/loaders";
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
import { relativeTime, type SessionDeletion, type SidebarSession } from "@/lib/nav/sidebar";
import { shownRows, type StatusRow, type StatusSection } from "@/lib/nav/status-groups";
import { isStanding, REASON_LABEL, STANDING_LABEL, STANDINGS, type SessionStanding } from "@/lib/session/standing";
import { cancelWarmOnRest, warmOnRest, warmSession } from "@/lib/session/warm-session";
import { cn } from "@/lib/utils";

/**
 * The sidebar's sessions by where they stand (lib/nav/status-groups.ts): a
 * heading for each group, folded with its chevron like a project, and its
 * sessions, each with a mark for its standing, a dot for a reply not seen,
 * and a menu to pin it, move it, archive or delete it.
 */
export function StatusSections({
  sections,
  active,
  now,
  folded,
  searching,
  onToggle,
  onDelete,
  onArchive,
}: {
  sections: StatusSection[];
  active?: string;
  now: number;
  /** Fold keys: `status:<section key>`. */
  folded: string[];
  searching: boolean;
  onToggle: (key: string) => void;
  onDelete: (session: { id: string; title: string; deletion: SessionDeletion }) => void;
  onArchive: (session: { id: string; title: string }) => void;
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
              <StatusRowLink key={row.id} row={row} active={row.id === active} now={now} onDelete={onDelete} onArchive={onArchive} />
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
  active,
  now,
  onDelete,
  onArchive,
}: {
  row: StatusRow;
  active: boolean;
  now: number;
  onDelete: (session: { id: string; title: string; deletion: SessionDeletion }) => void;
  onArchive: (session: { id: string; title: string }) => void;
}) {
  const { standing } = row;
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
        <StandingMark standing={standing} />
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
        onDelete={onDelete}
        onArchive={onArchive}
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
export function StandingMark({ standing, className }: { standing: SessionStanding; className?: string }) {
  const label = standing.reason ? REASON_LABEL[standing.reason] : STANDING_LABEL[standing.standing];
  const box = cn("size-3.5 shrink-0", className);
  switch (standing.standing) {
    case "needs_you":
      return <CircleAlert aria-label={label} className={cn(box, "text-amber-400")} />;
    case "working":
      return <Spinner label={label} className={cn(box, "text-muted-foreground")} />;
    case "in_review":
      return <GitPullRequest aria-label={label} className={cn(box, "text-emerald-400")} />;
    case "done":
      return <CircleCheck aria-label={label} className={cn(box, "text-muted-foreground")} />;
    case "backlog":
      return <CircleDashed aria-label={label} className={cn(box, "text-muted-foreground/70")} />;
  }
}

/**
 * A session's menu: Pin, Move to (a group by hand, or back to Automatic),
 * Archive and Delete, each where it applies. Shown on the row's hover, as
 * its buttons were.
 */
export function SessionMenu({
  session,
  markable,
  standing,
  onDelete,
  onArchive,
  className,
}: {
  session: Pick<SidebarSession, "id" | "title" | "deletion" | "archive">;
  /** A cloud session: Pin and Move to are offered. */
  markable: boolean;
  standing: SessionStanding | undefined;
  onDelete: (session: { id: string; title: string; deletion: SessionDeletion }) => void;
  onArchive: (session: { id: string; title: string }) => void;
  className?: string;
}) {
  const { deletion, archive } = session;
  if (!markable && !deletion && !archive) return null;
  const mark = (change: Parameters<typeof markSession>[1]) => {
    void markSession(session.id, change).catch((error: unknown) => {
      console.error(`Couldn't change ${session.id}'s marks`, error);
    });
  };
  return (
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
                  {STANDINGS.map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>
                      {STANDING_LABEL[s]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        {markable && standing && (archive || deletion) && <DropdownMenuSeparator />}
        {archive && (
          <DropdownMenuItem
            disabled={!archive.can}
            title={archive.can ? undefined : archive.why}
            onSelect={() => onArchive({ id: session.id, title: session.title })}
          >
            <Archive />
            Archive
          </DropdownMenuItem>
        )}
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
  );
}

/** A session row's right end: when it was last active, or, from the click until
 *  its page arrives, a spinner in the same box (useLinkStatus), so a click in
 *  the sidebar always answers. Steps aside on hover for the row's menu. */
export function RowTail({ at, now, hideOnHover }: { at: string; now: number; hideOnHover: boolean }) {
  const { pending } = useLinkStatus();
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
        className={cn("col-start-1 row-start-1 text-xs text-muted-foreground", pending && "invisible")}
      >
        {relativeTime(at, now)}
      </time>
      {pending && <Spinner label="Opening" className="col-start-1 row-start-1 size-3 text-muted-foreground" />}
    </span>
  );
}

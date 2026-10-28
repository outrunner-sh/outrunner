/**
 * The sidebar by where each session stands (lib/session/standing.ts), the
 * other way to list it than by project: pinned sessions first, then Needs
 * you, Working, In review, Done and Backlog, each most recent first. Built
 * from the project groups (lib/nav/sidebar.ts), so search, deletion and
 * archive work the same either way.
 *
 * Pure, so it is unit-tested without React.
 */

import type { SidebarGroup, SidebarSession } from "@/lib/nav/sidebar";
import {
  BACKLOG_AFTER_MS,
  sortStandings,
  STANDING_LABEL,
  STANDINGS,
  type SessionStanding,
  type Standing,
} from "@/lib/session/standing";

/** How the sidebar lists sessions: a cookie, read with the others. */
export const GROUPING_COOKIE = "sidebar-grouping";
export type Grouping = "status" | "projects";

export function readGrouping(value: string | undefined): Grouping {
  return value === "projects" ? "projects" : "status";
}

export function groupingCookie(grouping: Grouping): string {
  return `${GROUPING_COOKIE}=${grouping}; path=/; max-age=31536000; samesite=lax`;
}

export type StatusRow = SidebarSession & {
  /** Its project or folder, for the tooltip. */
  project: string;
  local: boolean;
  /** Pin and Move to are offered: a cloud session's marks are the server's. */
  markable: boolean;
  standing: SessionStanding;
};

export type StatusSection = {
  /** Also its fold key, `status:<key>`. */
  key: Standing | "pinned";
  label: string;
  rows: StatusRow[];
};

/**
 * A session the server hasn't placed (one on this Mac, or one made since the
 * last read): done, or backlog once it's quiet for three days. An archived one
 * is never working.
 */
export function fallbackStanding(at: string, now: number): SessionStanding {
  const quiet = now - Date.parse(at);
  return {
    standing: quiet >= BACKLOG_AFTER_MS ? "backlog" : "done",
    reason: null,
    moved: false,
    pinned: false,
    unread: false,
    replyPreview: null,
    at,
  };
}

export function buildStatusSections(
  groups: SidebarGroup[],
  standings: Record<string, SessionStanding>,
  now: number,
): StatusSection[] {
  const rows: StatusRow[] = groups.flatMap((group) =>
    group.sessions.map((session) => {
      const known = group.local ? undefined : standings[session.id];
      return {
        ...session,
        project: group.label,
        local: group.local,
        markable: !group.local,
        // The row's own time when it's newer: a session just used here is
        // listed as recent before the server's next read says so.
        standing: known
          ? { ...known, at: Date.parse(session.at) > Date.parse(known.at) ? session.at : known.at }
          : fallbackStanding(session.at, now),
      };
    }),
  );
  const pinned = sortStandings(rows.filter((r) => r.standing.pinned).map(withSortKeys));
  const sections: StatusSection[] = pinned.length > 0 ? [{ key: "pinned", label: "Pinned", rows: pinned }] : [];
  for (const standing of STANDINGS) {
    const inIt = rows.filter((r) => !r.standing.pinned && r.standing.standing === standing).map(withSortKeys);
    if (inIt.length > 0) sections.push({ key: standing, label: STANDING_LABEL[standing], rows: sortStandings(inIt) });
  }
  return sections;
}

/** sortStandings reads `pinned` and `at` off the row itself. */
function withSortKeys(row: StatusRow): StatusRow & { pinned: boolean } {
  return { ...row, pinned: row.standing.pinned, at: row.standing.at };
}

/** A section's rows shown before "Show more", unless it's opened. */
export const SECTION_SHOWN = 6;

/**
 * The rows a section shows: folded, only the session on screen; else the first
 * few unless it's opened in full, or a search is on (a match must never
 * hide), always keeping the one on screen.
 */
export function shownRows(
  section: StatusSection,
  options: { folded: boolean; expanded: boolean; searching: boolean; active?: string },
): { rows: StatusRow[]; hidden: number } {
  if (options.searching) return { rows: section.rows, hidden: 0 };
  if (options.folded) return { rows: section.rows.filter((r) => r.id === options.active), hidden: 0 };
  if (options.expanded || section.rows.length <= SECTION_SHOWN) return { rows: section.rows, hidden: 0 };
  const first = section.rows.slice(0, SECTION_SHOWN);
  const active = section.rows.find((r, i) => i >= SECTION_SHOWN && r.id === options.active);
  const rows = active ? [...first, active] : first;
  return { rows, hidden: section.rows.length - rows.length };
}

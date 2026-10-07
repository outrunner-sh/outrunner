/**
 * The app sidebar's model: one list of workspaces, each with its sessions
 * nested underneath, cloud repositories and this Mac's folders together. Pure,
 * so the grouping, ordering, search and time labels are tested without React.
 *
 * Cloud groups come from buildNavGroups and local ones from groupLocalSessions,
 * so the sidebar sorts and names them exactly as those already do; this only
 * puts the two side by side, newest activity first.
 */

import type { LocalSession } from "@/lib/desktop/local-runtime";
import { groupLocalSessions, localSessionLabel } from "@/lib/desktop/local-sessions";
import { workspaceLabel } from "@/lib/nav/session-title";
import { buildNavGroups, newestFirst, recency, type NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";

export type SidebarSession = {
  id: string;
  href: string;
  title: string;
  /** When it was last active, for ordering and the time label. */
  at: string;
};

export type SidebarGroup = {
  /** Unique across both kinds: a repository id and a folder path never collide. */
  key: string;
  label: string;
  /** Full name for the tooltip: `owner/repo`, or the folder's path. */
  detail: string;
  /** Lives on this Mac rather than in the cloud. */
  local: boolean;
  /** Where "new session in this workspace" starts; null when its repository
   *  could not be loaded, so there is nothing to start one in. */
  start: { kind: "cloud"; projectId: string } | { kind: "local"; folder: string } | null;
  /** Newest first. */
  sessions: SidebarSession[];
};

export function buildSidebarGroups(
  projects: NavProject[],
  workspaces: Workspace[],
  localSessions: LocalSession[],
): SidebarGroup[] {
  const known = new Set(projects.map((p) => p.id));
  const cloud: SidebarGroup[] = buildNavGroups(projects, workspaces).map(({ project, items }) => ({
    key: `cloud:${project.id}`,
    label: project.name,
    detail: project.fullName,
    local: false,
    // A placeholder group (buildNavGroups' fallbackProject) has no repository
    // behind it to create a session in.
    start: known.has(project.id) ? { kind: "cloud", projectId: project.id } : null,
    sessions: items.map((w) => ({
      id: w.id,
      href: `/workspaces/${w.id}`,
      title: workspaceLabel(w),
      at: recency(w),
    })),
  }));
  const local: SidebarGroup[] = groupLocalSessions(localSessions).map((group) => ({
    key: `local:${group.folder}`,
    label: group.label,
    detail: group.folder,
    local: true,
    start: { kind: "local", folder: group.folder },
    sessions: group.sessions
      .map((s) => ({
        id: s.workspaceId,
        href: `/local/${s.workspaceId}`,
        title: localSessionLabel(s),
        // Last use, not creation: comparable with a cloud session's activity.
        at: s.lastActiveAt || s.createdAt,
      }))
      .sort((a, b) => newestFirst(a.at, b.at)),
  }));
  // Both lists are newest-first inside; interleave the groups by their newest
  // session. A stable sort keeps each kind's own order on a tie.
  return [...cloud, ...local].sort((a, b) => newestFirst(a.sessions[0]?.at, b.sessions[0]?.at));
}

/**
 * The sidebar's search: case-insensitive, on session titles and workspace
 * names. A workspace whose name matches keeps all its sessions; otherwise only
 * the matching sessions stay, and a workspace left with none is dropped.
 */
export function filterSidebarGroups(groups: SidebarGroup[], query: string): SidebarGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.flatMap((group) => {
    if (group.label.toLowerCase().includes(q) || group.detail.toLowerCase().includes(q)) {
      return [group];
    }
    const sessions = group.sessions.filter((s) => s.title.toLowerCase().includes(q));
    return sessions.length > 0 ? [{ ...group, sessions }] : [];
  });
}

/** The session id an app path is showing, so the sidebar can mark it. */
export function activeSessionId(pathname: string): string | undefined {
  return /^\/(?:workspaces|local)\/([^/]+)/.exec(pathname)?.[1];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Compact age for a sidebar row: now, 5m, 3h, 2d, 1w, 4mo, 1y. Empty for a
 * missing or unparseable time; a time slightly in the future (clock skew)
 * reads as "now".
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const then = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) return "";
  const age = Math.max(0, now - then);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < WEEK) return `${Math.floor(age / DAY)}d`;
  if (age < 30 * DAY) return `${Math.floor(age / WEEK)}w`;
  if (age < 365 * DAY) return `${Math.floor(age / (30 * DAY))}mo`;
  return `${Math.floor(age / (365 * DAY))}y`;
}

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
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";
import { canDestroy } from "@/lib/session/provisioning";

/** Whether the sidebar is collapsed: a cookie, so the layout reads it on the
 *  server and the first render already has the sidebar as it was left (kept in
 *  localStorage, it opened wide and then snapped shut on every load). */
export const SIDEBAR_COOKIE = "sidebar-collapsed";

/** The projects folded shut in the sidebar, by group key: a cookie for the
 *  same reason as {@link SIDEBAR_COOKIE}. */
export const FOLDED_PROJECTS_COOKIE = "sidebar-folded";

/**
 * Both are read by the app layout for the frame, so every instant page under
 * it has to name them in its `unstable_instant` samples or the build stops.
 * The names are repeated there rather than imported from here: a segment
 * config is read by static analysis, which cannot follow a constant. Declared
 * absent, which is the shell's case — it is prerendered once, for nobody in
 * particular, and each visitor's own values stream in.
 */
/** A cookie holds about 4 KB; folder paths are long. The latest folds win. */
const MAX_FOLDED = 40;

/** The folded group keys a cookie holds; none for one that's missing or not
 *  ours. */
export function readFoldedProjects(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const keys: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** The `document.cookie` assignment that remembers `keys` folded. */
export function foldedProjectsCookie(keys: string[]): string {
  const kept = encodeURIComponent(JSON.stringify(keys.slice(-MAX_FOLDED)));
  return `${FOLDED_PROJECTS_COOKIE}=${kept}; path=/; max-age=31536000; samesite=lax`;
}

/** Remember `keys` folded, for the next page the server renders. */
export function rememberFoldedProjects(keys: string[]): void {
  document.cookie = foldedProjectsCookie(keys);
}

/** The sessions a project shows: all of them while it's open or a search is
 *  on (a match must never hide); folded, only the one on screen, so where you
 *  are stays in sight. */
export function shownSessions(
  group: SidebarGroup,
  options: { folded: boolean; searching: boolean; active?: string },
): SidebarSession[] {
  if (!options.folded || options.searching) return group.sessions;
  return group.sessions.filter((session) => session.id === options.active);
}

/** What deleting a session takes with it. */
export type SessionDeletion =
  /** A cloud session: its worktree on the Runtime Computer. */
  | { kind: "cloud" }
  /** A local session in a worktree: the worktree on this Mac; the branch stays
   *  in the folder's repository, in case it holds unpushed work. */
  | { kind: "local-worktree" }
  /** A local session that edited its folder in place: only the record of it. */
  | { kind: "local-in-place" };

export type SidebarSession = {
  id: string;
  href: string;
  title: string;
  /** When it was last active, for ordering and the time label. */
  at: string;
  /** What deleting it would do; null while it cannot be deleted (a cloud
   *  session still starting, or mid-way through another change). */
  deletion: SessionDeletion | null;
};

/** What the delete confirmation says will happen. */
export function deletionConsequence(deletion: SessionDeletion): string {
  switch (deletion.kind) {
    case "cloud":
      return "Its worktree on the Runtime Computer is removed. Anything pushed to GitHub stays.";
    case "local-worktree":
      return "Its worktree on this Mac is removed. The branch stays in your repository.";
    case "local-in-place":
      return "Outrunner forgets the session. Your folder and its files are untouched.";
  }
}

export type SidebarGroup = {
  /** Unique across both kinds: a repository id and a folder path never collide. */
  key: string;
  label: string;
  /** Full name for the tooltip: `owner/repo`, or the folder's path. */
  detail: string;
  /** Lives on this Mac rather than in the cloud. */
  local: boolean;
  /** Where "new session in this workspace" starts; null when its repository
   *  could not be loaded, so there is nothing to start one in, or for a Mac
   *  folder while new local sessions are off. */
  start: { kind: "cloud"; projectId: string } | { kind: "local"; folder: string } | null;
  /** Newest first. */
  sessions: SidebarSession[];
};

export function buildSidebarGroups(
  projects: NavProject[],
  workspaces: Workspace[],
  localSessions: LocalSession[],
  /** Whether a Mac folder can start a new session (lib/session/local-sessions.ts);
   *  its sessions are listed either way. */
  {
    startLocal = LOCAL_SESSIONS,
    now = Date.now(),
  }: {
    startLocal?: boolean;
    /** When deletability is judged: a stalled setup becomes deletable. */
    now?: number;
  } = {},
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
      // The server's own rule (the lifecycle route's destroy).
      deletion: canDestroy(w, now) ? { kind: "cloud" } : null,
    })),
  }));
  const local: SidebarGroup[] = groupLocalSessions(localSessions).map((group) => ({
    key: `local:${group.folder}`,
    label: group.label,
    detail: group.folder,
    local: true,
    start: startLocal ? { kind: "local", folder: group.folder } : null,
    sessions: group.sessions
      .map((s) => ({
        id: s.workspaceId,
        href: `/local/${s.workspaceId}`,
        title: localSessionLabel(s),
        // Last use, not creation: comparable with a cloud session's activity.
        at: s.lastActiveAt || s.createdAt,
        deletion: s.inPlace ? { kind: "local-in-place" as const } : { kind: "local-worktree" as const },
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

/**
 * Where a workspace's "+" goes: /new naming the repository or folder. The same
 * URL each time, so the page can be prefetched and kept; each click still opens
 * a fresh form (startNewSession, lib/session/new-session-reset.ts), even on the
 * URL already open, where the form may since have been switched to another
 * repository, folder, or to This Mac.
 */
export function newSessionHref(start: NonNullable<SidebarGroup["start"]>): string {
  const params = new URLSearchParams(
    start.kind === "cloud" ? { project: start.projectId } : { folder: start.folder },
  );
  return `/new?${params}`;
}

/** The session id an app path is showing, so the sidebar can mark it. */
export function activeSessionId(pathname: string): string | undefined {
  return /^\/(?:workspaces|local)\/([^/]+)/.exec(pathname)?.[1];
}

/** Whether an app path opens a session's studio (not its replay), whose header
 *  carries the collapsed sidebar's buttons in place of the rail. */
export function isStudioPath(pathname: string): boolean {
  return /^\/(?:workspaces|local)\/[^/]+\/?$/.test(pathname);
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

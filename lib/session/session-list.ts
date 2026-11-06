/**
 * The sessions list's model (app/(app)/workspaces): what a row shows, and the
 * search and filters over them, newest first. Pure, so it's unit-tested
 * without React.
 */

import { workspaceLabel } from "@/lib/nav/session-title";
import { fallbackStanding } from "@/lib/nav/status-groups";
import { recency } from "@/lib/nav/workspace-nav-groups";
import type { ProviderName, Workspace, WorkspacePullRequest, WorkspaceStatus } from "@/lib/runtime/types";
import type { AppData } from "@/lib/session/session-view";
import type { SessionStanding, Standing } from "@/lib/session/standing";
import { withoutGeneratedPrefix } from "@/lib/session/branch-name";

/** Where a session was started. */
export type SessionSource = "app" | "slack" | "triage" | "automation" | "mac";

export const SOURCE_LABEL: Record<SessionSource, string> = {
  app: "Outrunner",
  slack: "Slack",
  triage: "Triage",
  automation: "Automation",
  mac: "This Mac",
};

export type SessionListEntry = {
  id: string;
  title: string;
  branch: string;
  /** Its repository's `owner/name`, or a Mac session's folder name. */
  project: string;
  owner: { id: string; name: string; login: string | null; avatarUrl: string | null };
  /** The user's own: opened, pinned, archived and deleted from here. */
  mine: boolean;
  /** A session on this Mac (read from its agent, not the server). */
  local: boolean;
  source: SessionSource;
  createdAt: string;
  /** When it was last active. */
  at: string;
  /** A cloud session's lifecycle status; a Mac session's is "ready". */
  status: WorkspaceStatus;
  provider: ProviderName | null;
  pullRequest: { url: string; number: number; state: "open" | "closed" | "merged" } | null;
  /** As the server read it; null for one it hasn't (a Mac session). */
  standing: SessionStanding | null;
};

export type ListFilter = {
  query: string;
  /** "anyone", "me", or a user id. */
  owner: string;
  source: SessionSource | "any";
  status: Standing | "any";
};

export const NO_FILTER: ListFilter = { query: "", owner: "anyone", source: "any", status: "any" };

/** Where another member's session stands, as the list may show it: without
 *  its reply's words (their conversation, which session_activity keeps to
 *  its owner) or an unread mark, which is theirs, not the viewer's. */
export function othersStanding(standing: SessionStanding | undefined): SessionStanding | null {
  return standing ? { ...standing, replyPreview: null, unread: false } : null;
}

/** A row's standing: the server's, else worked out from its last activity. */
export function standingOf(entry: SessionListEntry, now: number): SessionStanding {
  return entry.standing ?? fallbackStanding(entry.at, now);
}

/**
 * The rows `filter` keeps, newest first. Search is case-insensitive over the
 * title, branch (without the generated `outrunner/` or `runtime/`), repository and owner.
 */
export function filterSessions(entries: SessionListEntry[], filter: ListFilter, now: number): SessionListEntry[] {
  const q = filter.query.trim().toLowerCase();
  return entries
    .filter((e) => {
      if (filter.owner === "me" && !e.mine) return false;
      if (filter.owner !== "me" && filter.owner !== "anyone" && e.owner.id !== filter.owner) return false;
      if (filter.source !== "any" && e.source !== filter.source) return false;
      if (filter.status !== "any" && standingOf(e, now).standing !== filter.status) return false;
      if (!q) return true;
      return [e.title, withoutGeneratedPrefix(e.branch), e.project, e.owner.name, e.owner.login ?? ""].some((field) =>
        field.toLowerCase().includes(q),
      );
    })
    .sort((a, b) => instant(b.createdAt) - instant(a.createdAt) || (a.id < b.id ? -1 : 1));
}

function instant(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/** The people the owner filter offers: the user first, then the others by
 *  name, each once. */
export function ownerChoices(entries: SessionListEntry[]): Array<{ id: string; name: string; mine: boolean }> {
  const seen = new Map<string, { id: string; name: string; mine: boolean }>();
  for (const e of entries) {
    if (!seen.has(e.owner.id)) seen.set(e.owner.id, { id: e.owner.id, name: e.owner.name, mine: e.mine });
  }
  return [...seen.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
}

/**
 * The rows the layout's own data already describes (components/app-data.tsx):
 * the user's cloud sessions in the active org, with their repository's name,
 * their pull request and where they stand. The page renders this while its own
 * read of /api/sessions is out, so the list opens with rows rather than a
 * spinner (components/sessions-list.tsx).
 *
 * It is not the whole list and doesn't pretend to be. Another member's sessions
 * take the server's read (they are read as the server, in the repositories the
 * user may read: lib/db/session-list.ts), and so does a session started from a
 * triage item — the layout reads neither the work items nor the automation
 * runs, so {@link startedFrom} can only say what the session's own row says.
 * Null when there is no layout data at all: then nothing is known, not even
 * that there is nothing.
 */
export function ownSessionEntries(data: AppData | null): SessionListEntry[] | null {
  if (!data) return null;
  const projects = new Map([...data.projects, ...data.hiddenProjects].map((p) => [p.id, p.fullName]));
  return data.workspaces.map((workspace) => ({
    id: workspace.id,
    title: workspaceLabel(workspace),
    branch: workspace.branch,
    project: projects.get(workspace.projectId) ?? "Repository",
    // Every row here is the user's own, and the layout doesn't carry the user's
    // own name; "You" is what the column shows for one's own session anyway.
    owner: { id: workspace.ownerId, name: "You", login: null, avatarUrl: null },
    mine: true,
    local: false,
    source: startedFrom(workspace),
    createdAt: workspace.createdAt,
    at: recency(workspace),
    status: workspace.status,
    provider: workspace.provider,
    pullRequest: pullRequestOf(data.pullRequests[workspace.id]),
    standing: data.standings?.[workspace.id] ?? null,
  }));
}

/**
 * Where a session was started, as its own row says (lib/runtime/types.ts). A
 * triage item's session, and a GitHub mention's, only read as triage once the
 * page has read the work items; until then they read as the app's own.
 */
function startedFrom(workspace: Workspace): SessionSource {
  if (workspace.source === "automation") return "automation";
  if (workspace.source === "slack" || workspace.slackThreadUrl) return "slack";
  return "app";
}

/** A pull request as a row shows it. */
function pullRequestOf(pullRequest: WorkspacePullRequest | undefined): SessionListEntry["pullRequest"] {
  return pullRequest ? { url: pullRequest.url, number: pullRequest.number, state: pullRequest.state ?? "open" } : null;
}

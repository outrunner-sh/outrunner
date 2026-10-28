/**
 * The sessions list's model (app/(app)/workspaces): what a row shows, and the
 * search and filters over them, newest first. Pure, so it's unit-tested
 * without React.
 */

import { fallbackStanding } from "@/lib/nav/status-groups";
import type { ProviderName, WorkspaceStatus } from "@/lib/runtime/types";
import type { SessionStanding, Standing } from "@/lib/session/standing";

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

/** A row's standing: the server's, else worked out from its last activity. */
export function standingOf(entry: SessionListEntry, now: number): SessionStanding {
  return entry.standing ?? fallbackStanding(entry.at, now);
}

/**
 * The rows `filter` keeps, newest first. Search is case-insensitive over the
 * title, branch (without the generated `runtime/`), repository and owner.
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
      return [e.title, e.branch.replace(/^runtime\//, ""), e.project, e.owner.name, e.owner.login ?? ""].some((field) =>
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

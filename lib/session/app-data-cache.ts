/**
 * The sidebar's list kept past the page, in localStorage, so a reload, a deep
 * link onto a session, or the app's relaunch shows the sessions the user was
 * working in at once rather than after the layout's queries answer
 * (app/(app)/layout.tsx).
 *
 * What is kept is the list itself: the projects, the sessions, the pull
 * requests the sidebar badges them with, and where each session stood — so a
 * sidebar grouped by status paints its groups at once too, rather than a
 * skeleton, and the frame reads where they stand now within seconds
 * (hooks/use-standings.ts), moving any that moved. Nothing of a session's own
 * page is kept: a conversation has a cache of its own
 * (lib/session/kept-conversations.ts), and its state comes from its stream.
 *
 * The kept list is a first-paint stand-in and nothing more. What the server
 * says always wins over it (components/app-frame.tsx), and it is dropped as
 * the user's own acts make it wrong: a session deleted or archived, the org
 * switched, or the user signed out. It is read through a `store` so a server
 * render — and hydration — sees null, and the list lands in the first commit
 * after (lib/client/store.ts).
 */

import { z } from "zod";

import { store, useStore } from "@/lib/client/store";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import type { AppData } from "@/lib/session/session-view";
import type { SessionStanding } from "@/lib/session/standing";

/** The sidebar's list as kept here: {@link AppData}, where each session stood
 *  included when it was read. */
export type CachedAppData = AppData;

/** A kept list, and the org the page that kept it was showing (the switcher's
 *  cookie, lib/orgs/active.ts; null before it was ever used): a list kept for
 *  another one is never shown. */
export type CachedList = { pickedOrgId: string | null; data: CachedAppData };

/** One entry, not one per org: what the frame shows at once is the list the
 *  user was last looking at, and the org it belongs to is kept inside it. */
const KEY = "outrunner:app-data";
const VERSION = 2;

/** How many sessions are kept: the most recently active, which is the order
 *  the sidebar lists them in (lib/db/repositories.ts). */
export const KEPT_WORKSPACES = 200;
/** How many repositories are kept: the most recently pushed, as listed. */
export const KEPT_PROJECTS = 200;
/** The most the entry may take, in characters of JSON. A list longer than this
 *  isn't kept: the sidebar opens as it did before, from the server. */
export const KEPT_CHARS = 500_000;

type AppDataStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What every reader of these keys on. The rest of each is carried through as
 * it was written: the entry is this app's own, put there by this build, and
 * the version is what drops one an older build left.
 */
function isProject(value: unknown): value is Project {
  return isRecord(value) && typeof value.id === "string" && typeof value.fullName === "string";
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    typeof value.status === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.branch === "string" &&
    (value.title === null || typeof value.title === "string") &&
    (value.checkouts === null || Array.isArray(value.checkouts))
  );
}

function isStanding(value: unknown): value is SessionStanding {
  return (
    isRecord(value) &&
    typeof value.standing === "string" &&
    typeof value.pinned === "boolean" &&
    typeof value.unread === "boolean" &&
    typeof value.at === "string"
  );
}

function isPullRequest(value: unknown): value is WorkspacePullRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.projectId === "string"
  );
}

const Stored = z.object({
  v: z.literal(VERSION),
  pickedOrgId: z.string().nullable(),
  data: z.object({
    projects: z.array(z.custom<Project>(isProject)),
    hiddenProjects: z.array(z.custom<Project>(isProject)),
    workspaces: z.array(z.custom<Workspace>(isWorkspace)),
    pullRequests: z.record(z.string(), z.custom<WorkspacePullRequest>(isPullRequest)),
    standings: z.record(z.string(), z.custom<SessionStanding>(isStanding)).optional(),
  }),
});

/**
 * The sidebar's list, as this browser kept it. A list the server sent is what
 * goes in: nothing derived here, and nothing belonging to a page.
 */
export class AppDataCache {
  private readonly storage: () => AppDataStorage | null;

  constructor(storage: () => AppDataStorage | null) {
    this.storage = storage;
  }

  /** The list kept here, if one was and this build can read it. */
  load(): CachedList | null {
    const storage = this.storage();
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    const parsed = Stored.safeParse(parseJson(raw));
    if (!parsed.success) {
      // Kept by an older build, or damaged: the sidebar opens from the server.
      this.clear();
      return null;
    }
    return { pickedOrgId: parsed.data.pickedOrgId, data: parsed.data.data };
  }

  /**
   * Keep `data` as the list read for `pickedOrgId`, trimmed to what is worth
   * keeping. Returns what was kept, and whether it differs from what was there
   * (the same list written twice needn't wake the frame); null when nothing
   * was kept, and no older copy may stand in for it either.
   */
  save(pickedOrgId: string | null, data: AppData): { list: CachedList; changed: boolean } | null {
    const storage = this.storage();
    if (!storage) return null;
    const list: CachedList = { pickedOrgId, data: trimmed(data) };
    const json = JSON.stringify({ v: VERSION, ...list });
    if (json.length > KEPT_CHARS) {
      // Too long to keep, even trimmed: it opens from the server.
      this.clear();
      return null;
    }
    try {
      const changed = storage.getItem(KEY) !== json;
      if (changed) storage.setItem(KEY, json);
      return { list, changed };
    } catch {
      // Out of room: nothing is kept, and no older list stands in for it.
      try {
        storage.removeItem(KEY);
      } catch {
        // Blocked storage keeps nothing to remove.
      }
      return null;
    }
  }

  /** Drop a session from the kept list: it was deleted or archived, and a
   *  reload must not show it as it was. */
  forget(workspaceId: string): CachedList | null {
    const kept = this.load();
    if (!kept) return null;
    const pullRequests = { ...kept.data.pullRequests };
    delete pullRequests[workspaceId];
    const standings = kept.data.standings && { ...kept.data.standings };
    if (standings) delete standings[workspaceId];
    const saved = this.save(kept.pickedOrgId, {
      ...kept.data,
      workspaces: kept.data.workspaces.filter((w) => w.id !== workspaceId),
      pullRequests,
      standings,
    });
    return saved?.list ?? null;
  }

  /** Forget the list for good: the user signed out, or switched orgs, and
   *  whoever looks next isn't shown it. */
  clear(): void {
    const storage = this.storage();
    if (!storage) return;
    try {
      storage.removeItem(KEY);
    } catch {
      // Blocked storage keeps nothing to forget.
    }
  }
}

/** What of a list is worth keeping: the rows the sidebar shows, most recent
 *  first, and the pull requests of the sessions among them. */
function trimmed(data: AppData): CachedAppData {
  const workspaces = data.workspaces.slice(0, KEPT_WORKSPACES);
  const kept = new Set(workspaces.map((w) => w.id));
  const pullRequests: Record<string, WorkspacePullRequest> = {};
  for (const [id, pullRequest] of Object.entries(data.pullRequests)) {
    if (kept.has(id)) pullRequests[id] = pullRequest;
  }
  const standings = data.standings
    ? Object.fromEntries(Object.entries(data.standings).filter(([id]) => kept.has(id)))
    : undefined;
  return {
    projects: data.projects.slice(0, KEPT_PROJECTS),
    hiddenProjects: data.hiddenProjects.slice(0, KEPT_PROJECTS),
    workspaces,
    pullRequests,
    ...(standings && { standings }),
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function browserStorage(): AppDataStorage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null; // Storage blocked: nothing is kept, the sidebar opens as before.
  }
}

/** This browser's kept list. */
export const APP_DATA_CACHE = new AppDataCache(browserStorage);

/** The list kept here, seeded before the page hydrates; a server render (and
 *  hydration) sees null, so the first paint matches the server's HTML. */
const KEPT = store<CachedList | null>(APP_DATA_CACHE.load());

/** The kept list, for the frame to render from while the server's is coming
 *  (components/app-frame.tsx). */
export function useCachedAppData(): CachedList | null {
  return useStore(KEPT, null);
}

/**
 * The kept list as the frame may show it: null when the page that kept it was
 * showing another org than this one is (both from the switcher's cookie, read
 * without a query), so one org's sessions never stand in for another's. An
 * absent cookie either side is unknown, not another org.
 */
export function cachedListFor(
  cached: CachedList | null,
  pickedOrgId: string | null | undefined,
): CachedAppData | null {
  if (!cached) return null;
  if (pickedOrgId && cached.pickedOrgId && pickedOrgId !== cached.pickedOrgId) return null;
  return cached.data;
}

/** Keep the list the layout just sent, for the sidebar's next cold start. */
export function rememberAppData(pickedOrgId: string | null, data: AppData): void {
  const saved = APP_DATA_CACHE.save(pickedOrgId, data);
  if (!saved) {
    KEPT.set(null);
    return;
  }
  if (saved.changed) KEPT.set(saved.list);
}

/** A session's list entry goes with it: it was deleted or archived. */
export function forgetCachedSession(workspaceId: string): void {
  const list = APP_DATA_CACHE.forget(workspaceId);
  if (list) KEPT.set(list);
}

/** Nothing is kept from here on: the user signed out, or switched orgs. */
export function clearAppDataCache(): void {
  APP_DATA_CACHE.clear();
  KEPT.set(null);
}

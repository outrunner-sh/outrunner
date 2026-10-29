import { z } from "zod";

import { store, useStore } from "@/lib/client/store";
import type { AccessLevel } from "@/lib/orgs/access";
import type { TriageItem, WorkItemNote } from "@/lib/triage/work-items";

/**
 * Triage kept past the page, in localStorage, so the list and the item opened
 * paint what they last showed at once — a reload, a deep link onto
 * `/triage?item=…`, the app's relaunch — rather than "Loading triage" and
 * "Loading the item" while the routes answer (components/triage/*).
 *
 * What is kept is what was shown: the items with what the caller may do with
 * each, where they may move them, and the last few items opened with their
 * notes. What the sidebar counts in triage is not — that is the layout's own
 * read (FrameData), and it stays the one count (components/app-sidebar.tsx).
 *
 * A kept list is a first-paint stand-in and nothing more: the server's answer
 * always wins over it, an item that is gone is answered for rather than shown,
 * and it goes as the user's own acts make it wrong — the org switched, the
 * user signed out. It is read into `store`s so a server render, and so
 * hydration, sees the empty snapshot (lib/client/store.ts): nothing reads
 * localStorage while rendering, and the kept items land in the first commit
 * after.
 *
 * The same shape as the sidebar's kept list (lib/session/app-data-cache.ts)
 * and the kept conversations (lib/session/kept-conversations.ts): a versioned
 * entry, validated on the way in, capped by characters, dropped when the store
 * is full rather than left half-written.
 */

/** One item as the detail pane shows it: the item, and its activity. */
export type KeptDetail = { item: TriageItem; notes: WorkItemNote[] };

/** What triage kept: the list, where items may be moved, and the items last
 *  opened (newest first). */
export type KeptTriage = {
  items: TriageItem[];
  levels: Record<string, AccessLevel>;
  orgLevel: AccessLevel | null;
  details: KeptDetail[];
};

const KEY = "outrunner:triage";
const VERSION = 1;

/** How many items are kept: the list, as the routes answer with it. */
export const KEPT_ITEMS = 300;
/** How many workspaces' access levels are kept, for the pickers. */
export const KEPT_LEVELS = 200;
/** How many opened items are kept, with their notes. */
export const KEPT_DETAILS = 3;
/** The most the entry may take, in characters of JSON. One longer isn't kept:
 *  triage opens as it did before, from the routes. */
export const KEPT_CHARS = 500_000;

type TriageStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isLevel(value: unknown): value is AccessLevel {
  return value === "read" || value === "write";
}

/**
 * What every reader of a kept item keys on: the rest of each is carried
 * through as it was written, since the entry is this app's own, put there by
 * this build, and the version is what drops one an older build left.
 */
function isItem(value: unknown): value is TriageItem {
  return (
    isRecord(value) &&
    isText(value.id) &&
    typeof value.number === "number" &&
    (value.projectId === null || isText(value.projectId)) &&
    isText(value.title) &&
    isText(value.body) &&
    isText(value.status) &&
    isText(value.source) &&
    (value.sourceUrl === null || isText(value.sourceUrl)) &&
    (value.duplicateOf === null || isText(value.duplicateOf)) &&
    (value.workspaceId === null || isText(value.workspaceId)) &&
    (value.ownSession === undefined || typeof value.ownSession === "boolean") &&
    isText(value.createdAt) &&
    isText(value.updatedAt) &&
    isRecord(value.can) &&
    typeof value.can.triage === "boolean" &&
    typeof value.can.contribute === "boolean"
  );
}

function isNote(value: unknown): value is WorkItemNote {
  return (
    isRecord(value) &&
    isText(value.id) &&
    isText(value.itemId) &&
    isText(value.body) &&
    isText(value.source) &&
    (value.sourceUrl === null || isText(value.sourceUrl)) &&
    (value.author === null || isText(value.author)) &&
    isText(value.createdAt)
  );
}

function isDetail(value: unknown): value is KeptDetail {
  return isRecord(value) && isItem(value.item) && Array.isArray(value.notes) && value.notes.every(isNote);
}

const Stored = z.object({
  v: z.literal(VERSION),
  items: z.array(z.custom<TriageItem>(isItem)),
  levels: z.record(z.string(), z.custom<AccessLevel>(isLevel)),
  orgLevel: z.custom<AccessLevel>(isLevel).nullable(),
  details: z.array(z.custom<KeptDetail>(isDetail)),
});

/**
 * Triage as this browser kept it. What the routes sent is what goes in.
 */
export class KeptTriageCache {
  private readonly storage: () => TriageStorage | null;

  constructor(storage: () => TriageStorage | null) {
    this.storage = storage;
  }

  /** What is kept here, if anything is and this build can read it. */
  load(): KeptTriage | null {
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
      // Kept by an older build, or damaged: triage opens from the server.
      this.clear();
      return null;
    }
    return parsed.data;
  }

  /**
   * Keep `entry` as what was just shown, trimmed to what is worth keeping.
   * Returns what was kept; null when nothing was, and no older copy may stand
   * in for it either.
   */
  save(entry: KeptTriage): KeptTriage | null {
    const storage = this.storage();
    if (!storage) return null;
    const kept = trimmed(entry);
    const json = JSON.stringify({ v: VERSION, ...kept });
    if (json.length > KEPT_CHARS) {
      // Too long to keep: triage opens from the server.
      this.clear();
      return null;
    }
    try {
      storage.setItem(KEY, json);
      return kept;
    } catch {
      // Out of room: nothing is kept, and no older list stands in for it.
      this.clear();
      return null;
    }
  }

  /** Forget everything kept, for good: whoever looks next isn't shown it. */
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

/** What of triage is worth keeping: the list, and the items last opened. */
function trimmed(entry: KeptTriage): KeptTriage {
  return {
    items: entry.items.slice(0, KEPT_ITEMS),
    levels: Object.fromEntries(Object.entries(entry.levels).slice(0, KEPT_LEVELS)),
    orgLevel: entry.orgLevel,
    details: entry.details.slice(0, KEPT_DETAILS),
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function browserStorage(): TriageStorage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null; // Storage blocked: nothing is kept, triage opens as before.
  }
}

/** This browser's kept triage. */
export const KEPT_TRIAGE = new KeptTriageCache(browserStorage);

/** How many items opened stay here for a re-entry: the list is what is looked
 *  at, and one just left is the one likely to be opened again. */
export const DETAILS_HELD = 8;

/** Triage as the page has it: the last answer, or what was kept until one
 *  comes. */
export type TriageSnapshot = {
  items: TriageItem[] | null;
  /** The caller's level on each workspace, for the pickers. */
  levels: Record<string, AccessLevel>;
  /** Their level on all of them. */
  orgLevel: AccessLevel | null;
};

/** The empty snapshot: what a server render, and so hydration, shows. */
export const NO_TRIAGE: TriageSnapshot = { items: null, levels: {}, orgLevel: null };

const kept = KEPT_TRIAGE.load();

/**
 * The list the whole page shows: the last answer, or what was kept until one
 * comes. Read through a `store` so a server render — and hydration — sees
 * {@link NO_TRIAGE} and the kept items land in the first commit after.
 */
const TRIAGE = store<TriageSnapshot>(
  kept ? { items: kept.items, levels: kept.levels, orgLevel: kept.orgLevel } : NO_TRIAGE,
);

/** The items opened here, most recently opened last (a Map keeps that order),
 *  and never more than {@link DETAILS_HELD}. */
const opened = new Map<string, KeptDetail>();
for (const detail of [...(kept?.details ?? [])].reverse()) opened.set(detail.item.id, detail);

/** The opened items, as a value: replaced on every change, since
 *  useSyncExternalStore re-renders forever on a new object per read. */
const OPENED = store<ReadonlyMap<string, KeptDetail>>(new Map(opened));

/** The opened items' empty snapshot: what a server render shows. */
const NO_OPENED: ReadonlyMap<string, KeptDetail> = new Map();

/** Triage as the page has it, for the list to render from. */
export function useTriage(): TriageSnapshot {
  return useStore(TRIAGE, NO_TRIAGE);
}

/** The same, read outside a component: what a server render shows, until an
 *  answer is published. */
export function triageSnapshot(): TriageSnapshot {
  return TRIAGE.get();
}

/** One item as it was last shown here, with its notes, or null. The server's
 *  answer replaces it as it lands. */
export function useKeptDetail(id: string): KeptDetail | null {
  return useStore(OPENED, NO_OPENED).get(id) ?? null;
}

/** Keep the list the routes just answered, for triage's next cold start. */
export function rememberTriage(next: { items: TriageItem[]; levels: Record<string, AccessLevel>; orgLevel: AccessLevel | null }): void {
  TRIAGE.set(next);
  keep();
}

/** Keep an item as the server just answered it, with its notes: a pane
 *  re-entered paints from this. */
export function rememberTriageDetail(detail: KeptDetail): void {
  opened.delete(detail.item.id);
  opened.set(detail.item.id, detail);
  while (opened.size > DETAILS_HELD) opened.delete(opened.keys().next().value as string);
  OPENED.set(new Map(opened));
  keep();
}

/** Forget the items on screen and the ones kept, for the org (or the user)
 *  leaving: the sidebar's switcher and the sign-out buttons. */
export function clearKeptTriage(): void {
  KEPT_TRIAGE.clear();
  opened.clear();
  OPENED.set(NO_OPENED);
  TRIAGE.set(NO_TRIAGE);
}

/** Write what is shown, for triage's next cold start. Nothing is kept before a
 *  list has been read: there would be nothing to keep the details with. */
function keep(): void {
  const list = TRIAGE.get();
  if (!list.items) return;
  KEPT_TRIAGE.save({
    items: list.items,
    levels: list.levels,
    orgLevel: list.orgLevel,
    details: [...opened.values()].reverse(),
  });
}

/**
 * How many items wait in triage, as the list just read says: the sidebar's
 * count shows it at once after a change here, instead of reading the whole
 * layout again (router.refresh). The layout's own count wins once it is read
 * again (components/app-frame.tsx). Null when the list doesn't say: none read
 * since, or one cut at its limit, which may leave some out.
 */
const TRIAGE_COUNT = store<number | null>(null);

/** Items the routes list at most (lib/db/work-items.ts). */
const LISTED_AT_MOST = 500;

export function useTriageCountAhead(): number | null {
  return useStore(TRIAGE_COUNT, null);
}

/** Count what waits in triage from the list just read. */
export function countTriageAhead(items: TriageItem[]): void {
  TRIAGE_COUNT.set(items.length < LISTED_AT_MOST ? items.filter((item) => item.status === "triage").length : null);
}

/** The layout read its own count: that one is shown again. */
export function forgetTriageCountAhead(): void {
  if (TRIAGE_COUNT.get() !== null) TRIAGE_COUNT.set(null);
}

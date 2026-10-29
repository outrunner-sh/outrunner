"use client";

import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

import { restoreDraft } from "@/lib/runtime/attachments";

/**
 * What has been typed and attached in a composer and not sent yet, kept by
 * where it was typed: `new` (the new-session form), `ws:<workspace id>` (a
 * session's composer), `triage:new/title`, `review:<repo>#<number>`… so it is
 * there again after the composer goes away and comes back — another page and
 * back, the browser's Back, a reload, a card that took the composer's place.
 *
 * Held in memory, so a composer mounting again has its draft in its first
 * render, and mirrored to localStorage a moment after each change (and as the
 * page goes), so a reload or the app's relaunch keeps it too. A server render,
 * and hydration, see no draft (nothing reads localStorage while rendering on
 * the server); the draft lands in the commit right after.
 *
 * A draft goes when it is sent (the composer empties it, and gives it back if
 * the send fails), when it is emptied by hand, and when the user signs out.
 * What is kept goes only once the send lands ({@link Drafts.hold}): a reload
 * while it is on its way brings the prompt back.
 * One left alone for {@link KEPT_DAYS} days, or past the newest
 * {@link KEPT_DRAFTS}, is dropped, its uploaded files deleted with it.
 */

/** A file staged on a composer (hooks/use-attachments.ts). */
export type PendingAttachment = {
  /** Stable key for the list. */
  key: string;
  /** The server's id, once uploaded. */
  id: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** What an image shows as: an object URL while the page that picked it is
   *  open, its {@link thumbnail} after a reload. */
  previewUrl: string | null;
  /** A small data URL of an image, kept with the draft so its preview
   *  survives a reload (an object URL doesn't). */
  thumbnail?: string | null;
  status: "uploading" | "ready" | "error";
  /** How much of it has uploaded, 0 to 1, while it uploads. */
  progress?: number;
  error?: string;
};

export type Draft = {
  text: string;
  attachments: PendingAttachment[];
};

const PREFIX = "outrunner:draft:";
/** Keys starting with this are never kept past the page: a composer with no
 *  place of its own. */
export const PAGE_ONLY = "~";
const VERSION = 1;

/** How long after it was last changed a draft is kept. */
export const KEPT_DAYS = 30;
/** How many drafts are kept: the most recently changed. */
export const KEPT_DRAFTS = 50;
/** How long after a change the draft is written: once typing pauses. */
export const SAVE_AFTER_MS = 250;
/** The most one draft may take, in characters of JSON. One longer isn't
 *  kept: it lasts as long as the page. */
export const KEPT_CHARS = 1_000_000;
/** The most all drafts together may take, in characters of JSON: the
 *  origin's storage is shared with the app's other caches (the sidebar's,
 *  triage's, the Runners'), and drafts mustn't crowd them out. Past it,
 *  thumbnails go first, the oldest drafts' first. */
export const KEPT_TOTAL_CHARS = 1_500_000;

/** Said of a file that was still uploading when the page went: the file is
 *  gone with the page, so it has to be attached again. */
export const INTERRUPTED_UPLOAD = "The page closed before it finished uploading. Remove it and attach it again.";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const Kept = z.object({
  v: z.literal(VERSION),
  at: z.number(),
  text: z.string(),
  attachments: z.array(
    z.object({
      key: z.string(),
      id: z.string().nullable(),
      filename: z.string(),
      contentType: z.string(),
      sizeBytes: z.number(),
      thumbnail: z.string().nullable().optional(),
      status: z.enum(["uploading", "ready", "error"]),
      progress: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});
type Kept = z.infer<typeof Kept>;

const EMPTY: Draft = { text: "", attachments: [] };

/** A send on its way (`Drafts.hold`): its text, and the files it took. */
type Held = { text: string; attachments: PendingAttachment[] };

/** The draft as a failed send would leave it: each held send's text and
 *  files back, oldest first, ahead of what the composer has now. */
function withHeld(holds: readonly Held[], shown: Draft): Draft {
  const text = holds.reduceRight((rest, held) => restoreDraft(held.text, rest), shown.text);
  const seen = new Set<string>();
  const attachments = [...holds.flatMap((held) => held.attachments), ...shown.attachments].filter((a) => {
    if (seen.has(a.key)) return false;
    seen.add(a.key);
    return true;
  });
  return { text, attachments };
}

function isEmpty(draft: Draft): boolean {
  return draft.text === "" && draft.attachments.length === 0;
}

function parse(raw: string | null): Kept | null {
  if (raw === null) return null;
  try {
    const kept = Kept.safeParse(JSON.parse(raw));
    return kept.success ? kept.data : null;
  } catch {
    return null;
  }
}

function withoutThumbnails(kept: Kept): Kept {
  return { ...kept, attachments: kept.attachments.map((a) => ({ ...a, thumbnail: null })) };
}

/** A kept draft as the composer shows it: a file the page went before it
 *  uploaded can't be finished, and says so. */
function revive(kept: Kept): Draft {
  return {
    text: kept.text,
    attachments: kept.attachments.map(({ progress, ...a }) => ({
      ...a,
      previewUrl: a.thumbnail ?? null,
      // How far it got is only worth showing for an upload still going.
      ...(a.status === "uploading" ? { status: "error" as const, error: INTERRUPTED_UPLOAD } : progress === undefined ? {} : { progress }),
    })),
  };
}

export class Drafts {
  private readonly storage: () => DraftStorage | null;
  private readonly schedule: (save: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly discard: (attachmentIds: string[]) => void;
  private readonly now: () => number;
  private readonly memory = new Map<string, Draft>();
  /** Keys whose kept draft has been read (or found missing). */
  private readonly read = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pending = new Map<string, unknown>();
  /** What each kept draft takes in storage, in characters, by key: read
   *  once, then kept up to date as drafts are written and removed, so the
   *  budget is checked without reading every draft each time. */
  private sizes: Map<string, number> | null = null;
  /** Attachments whose thumbnails were dropped for the budget, by draft:
   *  written without them from then on, so they don't come back and push
   *  another draft's out. */
  private readonly unpictured = new Map<string, Set<string>>();
  /** Text on its way in a send, by key, each send its own (`hold`). */
  private readonly held = new Map<string, Map<symbol, Held>>();
  private pruned = false;

  /**
   * `discard` lets go of uploaded files no draft holds any more (deletes them
   * server-side); `schedule`/`cancel` delay a write.
   */
  constructor({
    storage,
    discard,
    schedule = (save, ms) => setTimeout(save, ms),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now = Date.now,
  }: {
    storage: () => DraftStorage | null;
    discard: (attachmentIds: string[]) => void;
    schedule?: (save: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
    now?: () => number;
  }) {
    this.storage = storage;
    this.discard = discard;
    this.schedule = schedule;
    this.cancel = cancel;
    this.now = now;
  }

  /** The draft at `key`, or null where nothing has been typed or attached
   *  there (or it was emptied before a reload). */
  get(key: string): Draft | null {
    if (!this.read.has(key)) {
      this.read.add(key);
      this.prune();
      const kept = parse(this.safely((s) => s.getItem(PREFIX + key)) ?? null);
      if (kept && !this.memory.has(key)) this.memory.set(key, revive(kept));
    }
    return this.memory.get(key) ?? null;
  }

  /** Change the draft at `key`. An emptied one stays in memory (the box was
   *  cleared on purpose, and a prefill mustn't come back over it) and leaves
   *  storage. */
  update(key: string, change: (draft: Draft) => Draft): void {
    const before = this.get(key) ?? EMPTY;
    const after = change(before);
    if (after === before && this.memory.has(key)) return;
    this.memory.set(key, after);
    this.notify(key);
    this.later(key);
  }

  /** Set the text at `key`, or change it from what it is. */
  setText(key: string, text: string | ((current: string) => string)): void {
    this.update(key, (draft) => {
      const next = typeof text === "function" ? text(draft.text) : text;
      return next === draft.text ? draft : { ...draft, text: next };
    });
  }

  /**
   * Keep `text` and the files sent with it (`attachments`, taken off the
   * composer as it sends) stored at `key` while the send is on its way,
   * whatever the box shows: emptied at once, it is only kept empty once the
   * send lands, so a reload before then gives them back (ahead of anything
   * typed or attached since, as a failed send would). Call what it returns
   * when the send lands or fails. Sends overlapping on one key (one sent, the
   * composer away and back, another) each hold their own, oldest first.
   */
  hold(key: string, text: string, attachments: readonly PendingAttachment[] = []): () => void {
    const token = Symbol(key);
    let holds = this.held.get(key);
    if (!holds) this.held.set(key, (holds = new Map()));
    holds.set(token, { text, attachments: [...attachments] });
    const own = holds;
    return () => {
      if (!own.delete(token)) return;
      if (own.size === 0 && this.held.get(key) === own) this.held.delete(key);
      this.later(key);
    };
  }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** Write every change still waiting: the page is going. */
  flush(): void {
    for (const [key, handle] of this.pending) {
      this.cancel(handle);
      this.save(key);
    }
    this.pending.clear();
  }

  /** Forget every draft, here and kept, letting their uploads go: the user
   *  signed out. */
  clear(): void {
    for (const handle of this.pending.values()) this.cancel(handle);
    this.pending.clear();
    // Files of a send on its way are the message's now, not the draft's:
    // they aren't let go with it.
    const sending = new Set(
      [...this.held.values()].flatMap((holds) => [...holds.values()].flatMap((held) => held.attachments.map((a) => a.id))),
    );
    this.held.clear();
    const ids = new Set<string>();
    for (const draft of this.memory.values()) for (const a of draft.attachments) if (a.id) ids.add(a.id);
    for (const key of this.keptKeys()) {
      for (const a of parse(this.safely((s) => s.getItem(PREFIX + key)) ?? null)?.attachments ?? []) {
        if (a.id) ids.add(a.id);
      }
      this.erase(key);
    }
    this.unpictured.clear();
    const keys = [...this.memory.keys()];
    this.memory.clear();
    this.read.clear();
    const gone = [...ids].filter((id) => !sending.has(id));
    if (gone.length > 0) this.discard(gone);
    for (const key of keys) this.notify(key);
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private later(key: string): void {
    if (key.startsWith(PAGE_ONLY)) return;
    const waiting = this.pending.get(key);
    if (waiting !== undefined) this.cancel(waiting);
    this.pending.set(
      key,
      this.schedule(() => {
        this.pending.delete(key);
        this.save(key);
      }, SAVE_AFTER_MS),
    );
  }

  private save(key: string): void {
    const shown = this.memory.get(key) ?? EMPTY;
    const holds = [...(this.held.get(key)?.values() ?? [])];
    const draft = holds.length === 0 ? shown : withHeld(holds, shown);
    if (isEmpty(draft)) {
      this.erase(key);
      return;
    }
    const unpictured = this.unpictured.get(key);
    const kept: Kept = {
      v: VERSION,
      at: this.now(),
      text: draft.text,
      attachments: draft.attachments.map(
        ({ key: attachmentKey, id, filename, contentType, sizeBytes, thumbnail, status, progress, error }) => ({
          key: attachmentKey,
          id,
          filename,
          contentType,
          sizeBytes,
          thumbnail: unpictured?.has(attachmentKey) ? null : (thumbnail ?? null),
          status,
          ...(progress === undefined ? {} : { progress }),
          ...(error === undefined ? {} : { error }),
        }),
      ),
    };
    const fit = this.withinBudget(key, kept);
    // Too long, past the budget, or the store full (other caches share it):
    // kept for the page alone, rather than other drafts dropped for room. An
    // older copy goes, so a reload doesn't bring back what has since changed.
    if (fit === null || !this.write(key, fit.raw)) this.erase(key);
    else if (fit.unpictured) this.unpicture(key, kept);
  }

  /** `kept` as JSON, within {@link KEPT_CHARS} (its own thumbnails dropped
   *  if that's what it takes) and room made for it within
   *  {@link KEPT_TOTAL_CHARS} by dropping thumbnails, the oldest drafts' first
   *  and its own last; `unpictured` when its own went. Null where it still
   *  doesn't fit. */
  private withinBudget(key: string, kept: Kept): { raw: string; unpictured: boolean } | null {
    let raw = JSON.stringify(kept);
    let unpictured = false;
    if (raw.length > KEPT_CHARS) {
      raw = JSON.stringify(withoutThumbnails(kept));
      unpictured = true;
    }
    if (raw.length > KEPT_CHARS) return null;
    const sizes = this.keptSizes();
    let total = raw.length;
    for (const [k, size] of sizes) if (k !== key) total += size;
    if (total <= KEPT_TOTAL_CHARS) return { raw, unpictured };
    // Over: only now are the others read, each one's copy without its
    // thumbnails made once.
    const oldestFirst = [...sizes.keys()]
      .filter((k) => k !== key)
      .map((k) => {
        const draft = parse(this.safely((s) => s.getItem(PREFIX + k)) ?? null);
        const lighter = draft?.attachments.some((a) => a.thumbnail) ? JSON.stringify(withoutThumbnails(draft)) : null;
        return { key: k, draft, lighter };
      })
      .sort((a, b) => (a.draft?.at ?? 0) - (b.draft?.at ?? 0));
    // Every thumbnail gone and still over: nothing is touched for a draft
    // that won't be kept anyway.
    const ownLighter = unpictured ? raw : JSON.stringify(withoutThumbnails(kept));
    const floor = oldestFirst.reduce(
      (sum, { key: k, lighter }) => sum + (lighter?.length ?? sizes.get(k) ?? 0),
      ownLighter.length,
    );
    if (floor > KEPT_TOTAL_CHARS) return null;
    for (const { key: k, draft, lighter } of oldestFirst) {
      if (total <= KEPT_TOTAL_CHARS) break;
      if (!draft || lighter === null) continue;
      const before = sizes.get(k) ?? 0;
      if (this.write(k, lighter)) {
        this.unpicture(k, draft);
        total -= before - lighter.length;
      }
    }
    if (total > KEPT_TOTAL_CHARS && !unpictured) {
      total -= raw.length - ownLighter.length;
      raw = ownLighter;
      unpictured = true;
    }
    return total <= KEPT_TOTAL_CHARS ? { raw, unpictured } : null;
  }

  /** The draft at `key` is kept without these attachments' thumbnails from
   *  now on: they went for the budget. */
  private unpicture(key: string, kept: Kept): void {
    let set = this.unpictured.get(key);
    if (!set) this.unpictured.set(key, (set = new Set()));
    for (const a of kept.attachments) set.add(a.key);
  }

  private keptSizes(): Map<string, number> {
    if (!this.sizes) {
      this.sizes = new Map();
      for (const key of this.keptKeys()) this.sizes.set(key, this.safely((s) => s.getItem(PREFIX + key))?.length ?? 0);
    }
    return this.sizes;
  }

  private write(key: string, raw: string): boolean {
    const wrote = this.safely((s) => (s.setItem(PREFIX + key, raw), true)) ?? false;
    if (wrote) this.keptSizes().set(key, raw.length);
    return wrote;
  }

  private erase(key: string): void {
    this.safely((s) => s.removeItem(PREFIX + key));
    this.sizes?.delete(key);
    // Not kept, so nothing of it was dropped: tried in full next time.
    this.unpictured.delete(key);
  }

  /** Another tab wrote (or removed) the kept draft at `key`, or cleared
   *  storage (`key` null): what drafts take now, for the budget. */
  noteKept(key: string | null, raw: string | null): void {
    if (!this.sizes) return;
    if (key === null) this.sizes = null;
    else if (raw === null) this.sizes.delete(key);
    else this.sizes.set(key, raw.length);
  }

  /** Drop kept drafts past their age, past the newest {@link KEPT_DRAFTS},
   *  and any this build can't read, letting their uploads go. Once a page. */
  private prune(): void {
    if (this.pruned) return;
    this.pruned = true;
    const oldest = this.now() - KEPT_DAYS * 24 * 60 * 60 * 1000;
    const kept = this.keptKeys().map((key) => ({ key, draft: parse(this.safely((s) => s.getItem(PREFIX + key)) ?? null) }));
    kept.sort((a, b) => (b.draft?.at ?? 0) - (a.draft?.at ?? 0));
    const ids: string[] = [];
    kept.forEach(({ key, draft }, i) => {
      if (draft && draft.at >= oldest && i < KEPT_DRAFTS) return;
      // A draft open on this page is the page's, whatever is kept of it.
      if (this.memory.has(key)) return;
      for (const a of draft?.attachments ?? []) if (a.id) ids.push(a.id);
      this.erase(key);
    });
    if (ids.length > 0) this.discard(ids);
  }

  private keptKeys(): string[] {
    return (
      this.safely((s) => {
        const keys: string[] = [];
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i);
          if (key?.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length));
        }
        return keys;
      }) ?? []
    );
  }

  /** Storage blocked, full or missing (the server): nothing is kept, and the
   *  drafts live as long as the page. */
  private safely<T>(act: (storage: DraftStorage) => T): T | null {
    try {
      const storage = this.storage();
      return storage ? act(storage) : null;
    } catch {
      return null;
    }
  }
}

function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/** Delete uploaded files no draft holds: best-effort, and kept going as the
 *  page unloads. */
export function deleteAttachments(ids: readonly string[]): void {
  for (const id of ids) {
    void fetch(`/api/attachments/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }
}

/** This browser's drafts. */
export const DRAFTS = new Drafts({ storage: browserStorage, discard: deleteAttachments });

if (typeof window !== "undefined") {
  // Written as the page goes: a reload, a closed tab, the app quitting.
  window.addEventListener("pagehide", () => DRAFTS.flush());
  // Another tab's drafts count toward the same budget.
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key === null) DRAFTS.noteKept(null, null);
    else if (event.key.startsWith(PREFIX)) DRAFTS.noteKept(event.key.slice(PREFIX.length), event.newValue);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") DRAFTS.flush();
  });
}

/** The draft at `key`, kept up to date; null where there is none. A server
 *  render and hydration see none. */
export function useDraft(key: string): Draft | null {
  // Subscribed again only as the key changes, not at every render.
  const subscribe = useCallback((listener: () => void) => DRAFTS.subscribe(key, listener), [key]);
  return useSyncExternalStore(subscribe, () => DRAFTS.get(key), () => null);
}

/** A plain text box's draft: its text, and a setter that keeps it. */
export function useDraftText(key: string): [string, (text: string | ((current: string) => string)) => void] {
  const text = useDraft(key)?.text ?? "";
  // Stable, as a useState setter is.
  const set = useCallback((next: string | ((current: string) => string)) => DRAFTS.setText(key, next), [key]);
  return [text, set];
}

/**
 * A script for the server's HTML, placed right after a text box, that puts the
 * draft kept at `key` into it as the page loads: a reload then paints the box
 * with its draft rather than empty until the page hydrates (React keeps a
 * value the box already has as it hydrates it). Nothing is kept: nothing
 * happens.
 */
export function draftPaintScript(key: string): string {
  return `(function(){try{var b=document.currentScript.previousElementSibling,d=JSON.parse(localStorage.getItem(${JSON.stringify(
    PREFIX + key,
  ).replace(/</g, "\\u003c")}));if(b&&d&&d.v===${VERSION}&&d.text)b.value=d.text}catch(e){}})()`;
}

const noSubscription = () => () => {};

/** True while the page is still the server's HTML: in the server render and
 *  as it hydrates. */
export function useHydrating(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => false,
    () => true,
  );
}

/** Forget every draft: the user signed out. */
export function clearDrafts(): void {
  DRAFTS.clear();
}

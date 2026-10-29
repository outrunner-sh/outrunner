"use client";

import { store, useStore, type Store } from "@/lib/client/store";

/**
 * A page that paints what it last showed, at once, while the server's answer
 * streams in behind it: Review and Automations, whose routes read GitHub and
 * the database on every visit and so showed a loader on every one.
 *
 * What is kept is the page's own data as the server last sent it, in
 * localStorage, read into a `store` so a server render — and hydration — sees
 * nothing and the kept copy lands in the first commit after
 * (lib/client/store.ts). The server's answer always replaces it, and is kept
 * in its place. The same shape as the triage and sidebar lists
 * (lib/triage/kept-triage.ts, lib/session/app-data-cache.ts): a versioned
 * entry, checked on the way in, capped by characters, dropped whole when the
 * store is full rather than left half-written.
 *
 * Kept pages go as the user's own acts make them wrong: the org switched, the
 * user signed out ({@link clearKeptPages}).
 */

/** The most one page's entry may take, in characters of JSON. One longer
 *  isn't kept: the page opens as it did before, from the server. */
export const KEPT_PAGE_CHARS = 500_000;

const PREFIX = "outrunner:page:";

type PageStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type KeptPage<T> = {
  /** What the page last showed, or null: none kept, or before hydration. */
  useKept: () => T | null;
  /** The server just answered with `value`: show it, and keep it. */
  remember: (value: T) => void;
  /** Forget it, here and in storage. */
  clear: () => void;
};

const pages: KeptPage<unknown>[] = [];

/**
 * A page's kept copy, under `outrunner:page:<name>`. `version` drops one an
 * older build left; `valid` checks what a reader keys on, the rest being this
 * build's own, written by it.
 */
export function keptPage<T>(
  name: string,
  version: number,
  valid: (value: unknown) => value is T,
  storage: () => PageStorage | null = browserStorage,
): KeptPage<T> {
  const key = `${PREFIX}${name}`;
  const forget = () => {
    try {
      storage()?.removeItem(key);
    } catch {
      // Blocked storage keeps nothing to forget.
    }
  };
  const load = (): T | null => {
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    const parsed = parseJson(raw);
    if (!isRecord(parsed) || parsed.v !== version || !valid(parsed.value)) {
      // Kept by an older build, or damaged: the page opens from the server.
      forget();
      return null;
    }
    return parsed.value;
  };
  const shown: Store<T | null> = store(load());
  const page: KeptPage<T> = {
    useKept: () => useStore(shown, null),
    remember: (value) => {
      shown.set(value);
      const json = JSON.stringify({ v: version, value });
      if (json.length > KEPT_PAGE_CHARS) return forget();
      try {
        storage()?.setItem(key, json);
      } catch {
        // Out of room: nothing is kept, and no older copy stands in for it.
        forget();
      }
    },
    clear: () => {
      shown.set(null);
      forget();
    },
  };
  pages.push(page as KeptPage<unknown>);
  return page;
}

const others: (() => void)[] = [];

/** Run `forget` with {@link clearKeptPages}: for what a page holds in memory
 *  alone that belongs to the org or the user as well. */
export function forgetWithKeptPages(forget: () => void): void {
  others.push(forget);
}

/** Forget every kept page: the org switched, or the user signed out. Those
 *  this page hasn't loaded yet too, which are only in storage. */
export function clearKeptPages(): void {
  for (const page of pages) page.clear();
  for (const forget of others) forget();
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
    for (const key of keys) if (key?.startsWith(PREFIX)) storage.removeItem(key);
  } catch {
    // Blocked storage keeps nothing to forget.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function browserStorage(): PageStorage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null; // Storage blocked: nothing is kept, pages open as before.
  }
}

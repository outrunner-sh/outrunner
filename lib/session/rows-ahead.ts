"use client";

import { useMemo } from "react";

import { store, useStore } from "@/lib/client/store";
import type { Workspace } from "@/lib/runtime/types";
import type { AppData } from "@/lib/session/session-view";

/**
 * What this tab has just changed about a session, shown ahead of the
 * layout's list: a session archived (lib/session/optimistic-archive.ts), or
 * named by its first prompt. The list is re-read only when it must be — a
 * session it hasn't got appears (components/app-frame.tsx) — not on every
 * change made here, each of which used to re-run the sidebar's queries
 * (router.refresh).
 *
 * A change is laid over the session's row only while that row is from before
 * it: a row read since is the server's word, and wins.
 */
type Ahead = { patch: Partial<Workspace>; since: number };
const AHEAD = store<Record<string, Ahead>>({});
const NONE: Record<string, Ahead> = {};

/** Show `patch` on session `id` from now, ahead of the list. */
export function patchRowAhead(id: string, patch: Partial<Workspace>): void {
  const held = AHEAD.get()[id];
  AHEAD.set({ ...AHEAD.get(), [id]: { patch: { ...held?.patch, ...patch }, since: Date.now() } });
}

/** Stop showing anything ahead on session `id`: what was asked didn't happen. */
export function dropRowAhead(id: string, keys: (keyof Workspace)[]): void {
  const held = AHEAD.get()[id];
  if (!held) return;
  const patch = { ...held.patch };
  for (const key of keys) delete patch[key];
  const next = { ...AHEAD.get() };
  if (Object.keys(patch).length > 0) next[id] = { ...held, patch };
  else delete next[id];
  AHEAD.set(next);
}

/** `rows` as shown: each with what was changed here since it was read. */
export function rowsAhead(rows: Workspace[], ahead: Record<string, Ahead>): Workspace[] {
  let changed = false;
  const shown = rows.map((w) => {
    const held = ahead[w.id];
    if (!held || Date.parse(w.updatedAt) >= held.since) return w;
    changed = true;
    return { ...w, ...held.patch };
  });
  return changed ? shown : rows;
}

/** The layout's data as shown: the same object while nothing is ahead of it. */
export function useAppDataAhead(data: AppData | null): AppData | null {
  const ahead = useStore(AHEAD, NONE);
  return useMemo(() => {
    if (!data || ahead === NONE) return data;
    const workspaces = rowsAhead(data.workspaces, ahead);
    return workspaces === data.workspaces ? data : { ...data, workspaces };
  }, [data, ahead]);
}

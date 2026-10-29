"use client";

import { useEffect, useMemo } from "react";

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
 * it: a row read since is the server's word, and wins. "Before" never compares
 * the browser's clock with the server's, which can disagree by seconds:
 *
 * - The row the change was made over, when the list had it: its `updatedAt`,
 *   the server's own, which every write moves on (the workspaces_set_updated_at
 *   trigger). A listed row still at that or older is from before.
 * - Otherwise (a session the list didn't have yet, one just made here): when
 *   the list arrived in this tab, by this tab's clock, against when the change
 *   was made. A list that arrived since is the server's word.
 */
export type Ahead = {
  patch: Partial<Workspace>;
  /** The `updatedAt` of the row it was made over; null when the list had none. */
  over: string | null;
  /** When it was made, by this tab's clock. */
  since: number;
};
const AHEAD = store<Record<string, Ahead>>({});
const NONE: Record<string, Ahead> = {};

/** When each list the frame showed arrived in this tab. */
const arrived = new WeakMap<AppData, number>();
/** The list the frame shows now, for the rows a change is made over. */
let listed: AppData | null = null;

/** When `data` arrived here: when this tab first saw it. */
function arrivedAt(data: AppData): number {
  let at = arrived.get(data);
  if (at === undefined) {
    at = Date.now();
    arrived.set(data, at);
  }
  return at;
}

/** Show `patch` on session `id` from now, ahead of the list. */
export function patchRowAhead(id: string, patch: Partial<Workspace>): void {
  const held = AHEAD.get()[id];
  const over = listed?.workspaces.find((w) => w.id === id)?.updatedAt ?? null;
  AHEAD.set({ ...AHEAD.get(), [id]: { patch: { ...held?.patch, ...patch }, over, since: Date.now() } });
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

/** Whether `row`, from a list that arrived at `arrivedAt`, is from before the
 *  change held for it. */
export function isBefore(row: Workspace, held: Ahead, arrivedAt: number): boolean {
  if (held.over !== null) return Date.parse(row.updatedAt) <= Date.parse(held.over);
  return arrivedAt < held.since;
}

/** `rows` as shown: each with what was changed here since it was read. */
export function rowsAhead(rows: Workspace[], ahead: Record<string, Ahead>, arrivedAt: number): Workspace[] {
  let changed = false;
  const shown = rows.map((w) => {
    const held = ahead[w.id];
    if (!held || !isBefore(w, held, arrivedAt)) return w;
    changed = true;
    return { ...w, ...held.patch };
  });
  return changed ? shown : rows;
}

/** The layout's data as shown: the same object while nothing is ahead of it. */
export function useAppDataAhead(data: AppData | null): AppData | null {
  const ahead = useStore(AHEAD, NONE);
  useEffect(() => {
    if (data) arrivedAt(data);
    listed = data;
  }, [data]);
  return useMemo(() => {
    if (!data || ahead === NONE) return data;
    const workspaces = rowsAhead(data.workspaces, ahead, arrivedAt(data));
    return workspaces === data.workspaces ? data : { ...data, workspaces };
  }, [data, ahead]);
}

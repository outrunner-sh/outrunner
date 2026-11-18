"use client";

import { recency } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";
import { warmSession } from "@/lib/session/warm-session";

/**
 * The sidebar's sessions' conversations, brought into the page's cache before
 * any is clicked: a session this browser has never shown would otherwise open
 * on "Connecting to Claude" until its attach and its stream's replay came
 * back. Each is a sidebar warm-up (lib/session/warm-session.ts) that stops as
 * soon as its history is in, a few at a time, the most recently active first;
 * once in the cache, the conversation is kept past the page too
 * (lib/session/kept-conversations.ts), so the next visit needs none.
 */

/** How many sessions are brought in: the most recently active. Within the
 *  page's cache (CONVERSATIONS_KEPT), with room left for those opened. */
export const PREFETCH_SESSIONS = 10;
/** How long after the sidebar's list arrives (or changes) they are brought
 *  in: the page opened first, the sessions it shows after. */
export const PREFETCH_AFTER_MS = 1_500;
/** How many are brought in at once. */
const AT_ONCE = 2;
/** A session that had nothing to bring in (its box asleep, its agent not
 *  running) is asked again after this. */
export const PREFETCH_AGAIN_MS = 5 * 60_000;

/** Statuses whose box may be up: a warm-up answers for nothing else. */
const UP: Workspace["status"][] = ["ready", "idle"];

/**
 * Which sessions to bring in, the most recently active first: those listed
 * with a box that may be up, other than the one open (`current`), that the
 * page holds no conversation for (`held`) and hasn't tried lately (`tried`,
 * when each was last).
 */
export function sessionsToPrefetch(
  workspaces: readonly Workspace[],
  {
    current,
    held,
    tried,
    now,
    limit = PREFETCH_SESSIONS,
  }: {
    current: string | null;
    held: ReadonlySet<string>;
    tried: ReadonlyMap<string, number>;
    now: number;
    limit?: number;
  },
): string[] {
  return workspaces
    .filter((w) => UP.includes(w.status) && w.kind !== "mission")
    .sort((a, b) => recency(b).localeCompare(recency(a)))
    .slice(0, limit)
    .map((w) => w.id)
    .filter((id) => id !== current && !held.has(id) && now - (tried.get(id) ?? -Infinity) >= PREFETCH_AGAIN_MS);
}

const tried = new Map<string, number>();
let running = false;
/** What it was last asked for, while a run was under way: run once more after. */
let asked: { workspaces: readonly Workspace[]; current: string | null } | null = null;

/**
 * Bring in the conversations of `workspaces` that this browser doesn't have,
 * one run at a time: asked again while one runs, it runs once more after, for
 * what it was last asked.
 */
export function prefetchSessions(workspaces: readonly Workspace[], current: string | null): void {
  if (running) {
    asked = { workspaces, current };
    return;
  }
  running = true;
  void (async () => {
    const ids = workspaces.filter((w) => UP.includes(w.status)).map((w) => w.id);
    const held = await CONVERSATIONS.held(ids);
    const queue = sessionsToPrefetch(workspaces, { current, held, tried, now: Date.now() });
    for (const id of queue) tried.set(id, Date.now());
    const next = async (): Promise<void> => {
      const id = queue.shift();
      if (id === undefined) return;
      await warmSession(id, { settle: true });
      return next();
    };
    await Promise.all(Array.from({ length: AT_ONCE }, next));
  })().finally(() => {
    running = false;
    const then = asked;
    asked = null;
    if (then) prefetchSessions(then.workspaces, then.current);
  });
}

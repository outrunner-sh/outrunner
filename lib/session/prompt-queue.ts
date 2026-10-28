/**
 * Prompts sent while the session's agent is at work: held here, above the
 * composer, rather than handed to it mid-turn, and sent one at a time, in
 * order, as each turn ends. Kept for the tab (sessionStorage), so a reload
 * doesn't lose them; a tab closed before they go does.
 */

import type { SessionMode } from "@/lib/runtime/agent-protocol";

/** `mode` is the one it was queued in (lib/session/session-mode.ts), and goes
 *  in; absent from a queue kept before modes, which goes in the session's. */
export type QueuedPrompt = { id: string; text: string; attachmentIds: string[]; mode?: SessionMode };

/** Where the queue is kept: sessionStorage, or a stand-in in tests. */
export type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (workspaceId: string) => `outrunner:queue:${workspaceId}`;

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== "object") return false;
  const { id, text, attachmentIds, mode } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    (mode === undefined || mode === "plan" || mode === "build") &&
    typeof text === "string" &&
    Array.isArray(attachmentIds) &&
    attachmentIds.every((a) => typeof a === "string") &&
    (text.trim() !== "" || attachmentIds.length > 0)
  );
}

/** The session's queue as this tab kept it; empty where there is none, or
 *  none that can be read (what can't be is dropped, not sent). */
export function readQueue(storage: QueueStorage | null, workspaceId: string): QueuedPrompt[] {
  try {
    const raw = storage?.getItem(key(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isQueuedPrompt) : [];
  } catch {
    return [];
  }
}

/** Keep `queue` for the tab; an empty one is forgotten. */
export function writeQueue(storage: QueueStorage | null, workspaceId: string, queue: QueuedPrompt[]): void {
  try {
    if (queue.length > 0) storage?.setItem(key(workspaceId), JSON.stringify(queue));
    else storage?.removeItem(key(workspaceId));
  } catch {
    // Storage full or blocked: the queue still works, until a reload.
  }
}

/**
 * Whether the next queued prompt goes now: the session takes prompts (it's
 * attached), its agent isn't at work or waiting on the user's answer, the
 * stream has recorded the last queued prompt sent (`awaitingLast` until it
 * has: one of files alone shows no bubble meanwhile), and the queue isn't
 * held after a send of it failed (until the user retries).
 */
export function queueDrains(state: {
  queued: number;
  attached: boolean;
  working: boolean;
  waitingOnUser: boolean;
  held: boolean;
  awaitingLast: boolean;
}): boolean {
  return (
    state.queued > 0 &&
    state.attached &&
    !state.working &&
    !state.waitingOnUser &&
    !state.held &&
    !state.awaitingLast
  );
}

/**
 * Prompts sent while the session's agent is at work: held here, above the
 * composer, rather than handed to it mid-turn, and sent one at a time, in
 * order, as each turn ends. Each can be edited or moved while it waits, or
 * sent early: steered into the running turn, or sent now, the turn stopped
 * first. (With "Steer with follow-up messages" on, lib/session/
 * chat-preferences.ts, a prompt sent mid-turn steers instead of queuing.) Kept for the tab (sessionStorage), so a reload
 * doesn't lose them; a tab closed before they go does.
 */

import type { SessionMode } from "@/lib/runtime/agent-protocol";
import { parseCommentQuotes, withComments } from "@/lib/session/diff-comments";

/** `mode` is the one it was queued in (lib/session/session-mode.ts), and goes
 *  in; absent from a queue kept before modes, which goes in the session's. */
export type QueuedPrompt = { id: string; text: string; attachmentIds: string[]; mode?: SessionMode; startup?: boolean; sentAt?: number };

/** Where the queue is kept: sessionStorage, or a stand-in in tests. */
export type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (workspaceId: string) => `outrunner:queue:${workspaceId}`;

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== "object") return false;
  const { id, text, attachmentIds, mode, startup, sentAt } = value as Record<string, unknown>;
  return (
    (startup === undefined || typeof startup === "boolean") &&
    (sentAt === undefined || (typeof sentAt === "number" && Number.isSafeInteger(sentAt) && sentAt >= 0)) &&
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
export function writeQueue(storage: QueueStorage | null, workspaceId: string, queue: QueuedPrompt[]): boolean {
  try {
    if (!storage) return false;
    if (queue.length > 0) storage.setItem(key(workspaceId), JSON.stringify(queue));
    else storage.removeItem(key(workspaceId));
    return true;
  } catch {
    // The caller can retain the draft rather than accept an undurable send.
    return false;
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
  editing?: boolean;
  awaitingLast: boolean;
}): boolean {
  return (
    state.queued > 0 &&
    state.attached &&
    !state.working &&
    !state.waitingOnUser &&
    !state.held &&
    !state.editing &&
    !state.awaitingLast
  );
}

/** The queue with one prompt's words changed to `words`, the comments on the
 *  diff it carries kept as they were. Unchanged where that would leave it
 *  with nothing to send. */
export function editQueued(queue: QueuedPrompt[], id: string, words: string): QueuedPrompt[] {
  return queue.map((prompt) => {
    if (prompt.id !== id || prompt.sentAt !== undefined) return prompt;
    const { quotes } = parseCommentQuotes(prompt.text);
    const text = withComments(words.trim(), quotes);
    return text.trim() || prompt.attachmentIds.length > 0 ? { ...prompt, text } : prompt;
  });
}

/** The queue with one prompt moved `by` places (-1 sooner, 1 later), kept
 *  within it. */
export function moveQueued(queue: QueuedPrompt[], id: string, by: number): QueuedPrompt[] {
  const from = queue.findIndex((prompt) => prompt.id === id);
  if (from < 0) return queue;
  const to = Math.max(0, Math.min(queue.length - 1, from + by));
  if (to === from) return queue;
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Start over carries waiting input to the replacement session. Its new
 * conversation gets fresh echo anchors; its per-message keys remain stable. */
export function transferQueue(storage: QueueStorage | null, from: string, to: string): boolean {
  const queue = readQueue(storage, from);
  if (queue.length === 0) return true;
  const existing = readQueue(storage, to);
  const ids = new Set(existing.map((p) => p.id));
  const carried = queue.filter((p) => !ids.has(p.id)).map((p) => {
    const waiting = { ...p };
    delete waiting.sentAt;
    return waiting;
  });
  if (!writeQueue(storage, to, [...existing, ...carried])) return false;
  writeQueue(storage, from, []);
  return true;
}

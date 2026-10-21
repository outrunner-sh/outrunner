import { z } from "zod";

import { AgentEvent } from "@/lib/runtime/agent-protocol";
import type { CachedConversation, ConversationStore } from "@/lib/session/conversation-cache";

/**
 * Conversations kept past the page, in localStorage, so a session opened after
 * a reload or the app's relaunch shows its conversation at once rather than
 * after the attach and the stream's replay of its history.
 *
 * What is kept is what was shown, not where the stream left off: a kept
 * conversation's stream replays from the start, which the conversation takes
 * in without doubling (lib/runtime/conversation-events.ts). A cursor kept for
 * days could point into a log the box has since started over, and resuming
 * there would show nothing new, or half a line.
 *
 * A session's state isn't kept either: it was true when it was seen, and the
 * stream says it again as it opens.
 */

const PREFIX = "outrunner:conversation:";
const INDEX_KEY = "outrunner:conversations";
const VERSION = 1;

/** How many sessions' conversations are kept: the most recently opened. */
export const KEPT_SESSIONS = 10;
/** The most one session may take, in characters of JSON. One longer isn't
 *  kept: it opens as it did before, from the stream. */
export const KEPT_CHARS = 1_000_000;
/** How often a conversation that changed is written: at most once a second,
 *  however fast a reply streams in. */
export const SAVE_EVERY_MS = 1000;

type KeptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const Kept = z.object({
  v: z.literal(VERSION),
  events: z.array(AgentEvent),
  seenIds: z.array(z.string()),
});

export class KeptConversations implements ConversationStore {
  private readonly storage: () => KeptStorage | null;
  private readonly schedule: (flush: () => void) => void;
  private readonly pending = new Map<string, CachedConversation>();
  private scheduled = false;
  /** Forgotten by `clear`: the user signed out, and nothing more is kept or
   *  shown for the rest of the page. Sign-out takes a round trip before the
   *  redirect lands, and a session still streaming would otherwise write its
   *  conversation back in that window. */
  private forgotten = false;

  /** `schedule` arranges for `flush` to run a little later: once per batch of
   *  saves, not once per save. */
  constructor(storage: () => KeptStorage | null, schedule: (flush: () => void) => void) {
    this.storage = storage;
    this.schedule = schedule;
  }

  load(id: string): Pick<CachedConversation, "events" | "seenIds"> | undefined {
    if (this.forgotten) return undefined;
    const storage = this.storage();
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(PREFIX + id);
      if (raw === null) return undefined;
      const parsed = Kept.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        // Kept by an older build, or damaged: it opens from the stream.
        this.remove(id);
        return undefined;
      }
      this.writeIndex(storage, [...this.readIndex(storage).filter((kept) => kept !== id), id]);
      return { events: parsed.data.events, seenIds: new Set(parsed.data.seenIds) };
    } catch {
      return undefined;
    }
  }

  save(id: string, entry: CachedConversation): void {
    if (this.forgotten) return;
    this.pending.set(id, entry);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  /** Write what has changed since the last flush. */
  flush(): void {
    this.scheduled = false;
    const pending = [...this.pending];
    this.pending.clear();
    if (this.forgotten) return;
    const storage = this.storage();
    if (!storage) return;
    for (const [id, entry] of pending) {
      try {
        this.write(storage, id, entry);
      } catch {
        // Storage gone bad mid-write: this one opens from the stream.
      }
    }
  }

  remove(id: string): void {
    this.pending.delete(id);
    const storage = this.storage();
    if (!storage) return;
    try {
      storage.removeItem(PREFIX + id);
      this.writeIndex(storage, this.readIndex(storage).filter((kept) => kept !== id));
    } catch {
      // Blocked storage keeps nothing to remove.
    }
  }

  /** Forget every kept conversation, for good: whoever signs in next isn't
   *  shown them, and nothing this page goes on to stream is kept. */
  clear(): void {
    this.forgotten = true;
    this.pending.clear();
    const storage = this.storage();
    if (!storage) return;
    try {
      for (const id of this.readIndex(storage)) storage.removeItem(PREFIX + id);
      storage.removeItem(INDEX_KEY);
    } catch {
      // Blocked storage keeps nothing to forget.
    }
  }

  private write(storage: KeptStorage, id: string, entry: CachedConversation): void {
    const events = entry.events.filter((event) => event.t !== "state");
    const json = JSON.stringify({ v: VERSION, events, seenIds: [...entry.seenIds] });
    if (events.length === 0 || json.length > KEPT_CHARS) {
      // Nothing to show at once, or too long to keep: no older copy may stand
      // in for it either.
      this.remove(id);
      return;
    }
    const index = this.readIndex(storage).filter((kept) => kept !== id);
    while (index.length >= KEPT_SESSIONS) {
      const oldest = index.shift();
      if (oldest !== undefined) storage.removeItem(PREFIX + oldest);
    }
    // Out of room: the least recently opened make way, until this fits or
    // there is no one left to make way.
    for (;;) {
      try {
        storage.setItem(PREFIX + id, json);
        break;
      } catch {
        const oldest = index.shift();
        if (oldest === undefined) {
          this.writeIndex(storage, index);
          return;
        }
        storage.removeItem(PREFIX + oldest);
      }
    }
    this.writeIndex(storage, [...index, id]);
  }

  private readIndex(storage: KeptStorage): string[] {
    try {
      const parsed = z.array(z.string()).safeParse(JSON.parse(storage.getItem(INDEX_KEY) ?? "[]"));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private writeIndex(storage: KeptStorage, index: string[]): void {
    try {
      storage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
      // Full: the entries are there, and the next write orders them again.
    }
  }
}

function browserStorage(): KeptStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // Storage blocked: nothing is kept, sessions open as before.
  }
}

let leaving = false;
/** Write a second after the first change, and at once as the page goes. */
function browserSchedule(flush: () => void): void {
  setTimeout(flush, SAVE_EVERY_MS);
  if (leaving || typeof window === "undefined") return;
  leaving = true;
  const now = () => KEPT_CONVERSATIONS.flush();
  window.addEventListener("pagehide", now);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") now();
  });
}

/** This browser's kept conversations. */
export const KEPT_CONVERSATIONS = new KeptConversations(browserStorage, browserSchedule);

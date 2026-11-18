import { z } from "zod";

import { AgentEvent } from "@/lib/runtime/agent-protocol";
import type { CachedConversation, ConversationStore } from "@/lib/session/conversation-cache";

/**
 * Conversations kept past the page, in IndexedDB, so a session opened after a
 * reload, a new deploy or the app's relaunch shows its conversation at once
 * rather than after its box wakes, the attach and the stream's replay of its
 * history. IndexedDB rather than localStorage: a long session's conversation
 * runs to megabytes, and localStorage's few for the whole site, shared with
 * drafts and the sidebar, held only two or three.
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
export const KEPT_SESSIONS = 30;
/** The most one session may take, in characters of JSON. One longer isn't
 *  kept: it opens as it did before, from the stream. */
export const KEPT_CHARS = 5_000_000;
/** How often a conversation that changed is written: at most once a second,
 *  however fast a reply streams in. */
export const SAVE_EVERY_MS = 1000;

/** Where conversations are kept: strings by key, read and written in turn. A
 *  write that finds no room rejects. */
export type KeptStorage = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

/** localStorage, where builds before IndexedDB kept them. */
type LegacyStorage = Pick<Storage, "getItem" | "removeItem" | "key" | "length">;

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
  /** Every read and write, one after another: each reads the index, and one
   *  interleaved with another would write back an index the other changed. */
  private queue: Promise<unknown> = Promise.resolve();
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

  load(id: string): Promise<Pick<CachedConversation, "events" | "seenIds"> | undefined> {
    return this.run(async (storage) => {
      if (this.forgotten) return undefined;
      const raw = await storage.get(PREFIX + id);
      if (raw === undefined) return undefined;
      let parsed;
      try {
        parsed = Kept.safeParse(JSON.parse(raw));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) {
        // Kept by an older build, or damaged: it opens from the stream.
        await this.drop(storage, id);
        return undefined;
      }
      await this.writeIndex(storage, [...(await this.readIndex(storage)).filter((kept) => kept !== id), id]);
      return { events: parsed.data.events, seenIds: new Set(parsed.data.seenIds) };
    }, undefined);
  }

  ids(): Promise<string[]> {
    return this.run(async (storage) => (this.forgotten ? [] : this.readIndex(storage)), []);
  }

  save(id: string, entry: CachedConversation): void {
    if (this.forgotten) return;
    this.pending.set(id, entry);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => void this.flush());
  }

  /** Write what has changed since the last flush. */
  flush(): Promise<void> {
    this.scheduled = false;
    const pending = [...this.pending];
    this.pending.clear();
    return this.run(async (storage) => {
      if (this.forgotten) return;
      for (const [id, entry] of pending) {
        try {
          await this.write(storage, id, entry);
        } catch {
          // Storage gone bad mid-write: this one opens from the stream.
        }
      }
    }, undefined);
  }

  remove(id: string): Promise<void> {
    this.pending.delete(id);
    return this.run((storage) => this.drop(storage, id), undefined);
  }

  /** Forget every kept conversation, for good: whoever signs in next isn't
   *  shown them, and nothing this page goes on to stream is kept. Every key
   *  kept, not the ones the index lists: the two can fall out of step (a
   *  write that failed half done), and one the index lost would otherwise
   *  outlive the sign-out. */
  clear(): Promise<void> {
    this.forgotten = true;
    this.pending.clear();
    return this.run(async (storage) => {
      for (const key of await storage.keys()) {
        if (key.startsWith(PREFIX) || key === INDEX_KEY) await storage.delete(key);
      }
    }, undefined);
  }

  /** Take in what an older build kept in localStorage, the most recently
   *  opened last, and leave none of it there: it was taking up the room the
   *  site's drafts and lists share. */
  adopt(legacy: LegacyStorage): Promise<void> {
    let taken: [string, string][];
    try {
      taken = takeLegacy(legacy);
    } catch {
      return Promise.resolve(); // Blocked storage held nothing.
    }
    if (taken.length === 0) return Promise.resolve();
    return this.run(async (storage) => {
      if (this.forgotten) return;
      const index = await this.readIndex(storage);
      // One this build has kept since is newer; and older than any it kept,
      // they take only the room left.
      const fresh = taken.filter(([id]) => !index.includes(id));
      const room = Math.max(0, KEPT_SESSIONS - index.length);
      const adopted: string[] = [];
      for (const [id, json] of fresh.slice(fresh.length - Math.min(room, fresh.length))) {
        await storage.set(PREFIX + id, json);
        adopted.push(id);
      }
      await this.writeIndex(storage, [...adopted, ...index]);
    }, undefined);
  }

  /** Run `op` once those before it are done; with no storage, or one that
   *  fails, it answers `fallback`. */
  private run<T>(op: (storage: KeptStorage) => Promise<T>, fallback: T): Promise<T> {
    const next = this.queue.then(async () => {
      const storage = this.storage();
      if (!storage) return fallback;
      try {
        return await op(storage);
      } catch {
        return fallback;
      }
    });
    this.queue = next;
    return next;
  }

  private async drop(storage: KeptStorage, id: string): Promise<void> {
    await storage.delete(PREFIX + id);
    await this.writeIndex(storage, (await this.readIndex(storage)).filter((kept) => kept !== id));
  }

  private async write(storage: KeptStorage, id: string, entry: CachedConversation): Promise<void> {
    const events = entry.events.filter((event) => event.t !== "state");
    const json = JSON.stringify({ v: VERSION, events, seenIds: [...entry.seenIds] });
    if (events.length === 0 || json.length > KEPT_CHARS) {
      // Nothing to show at once, or too long to keep: no older copy may stand
      // in for it either.
      await this.drop(storage, id);
      return;
    }
    const index = (await this.readIndex(storage)).filter((kept) => kept !== id);
    while (index.length >= KEPT_SESSIONS) {
      const oldest = index.shift();
      if (oldest !== undefined) await storage.delete(PREFIX + oldest);
    }
    // Out of room: the least recently opened make way, until this fits or
    // there is no one left to make way.
    for (;;) {
      try {
        await storage.set(PREFIX + id, json);
        break;
      } catch {
        const oldest = index.shift();
        if (oldest === undefined) {
          // No room even on its own: no older copy may stand in for it.
          await storage.delete(PREFIX + id);
          await this.writeIndex(storage, index);
          return;
        }
        await storage.delete(PREFIX + oldest);
      }
    }
    await this.writeIndex(storage, [...index, id]);
  }

  private async readIndex(storage: KeptStorage): Promise<string[]> {
    try {
      const parsed = z.array(z.string()).safeParse(JSON.parse((await storage.get(INDEX_KEY)) ?? "[]"));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(storage: KeptStorage, index: string[]): Promise<void> {
    try {
      await storage.set(INDEX_KEY, JSON.stringify(index));
    } catch {
      // Full: the entries are there, and the next write orders them again.
    }
  }
}

/** What localStorage kept, the most recently opened last, removed from it. */
function takeLegacy(legacy: LegacyStorage): [string, string][] {
  const keys: string[] = [];
  // Collected before any removal: removing one renumbers the rest.
  for (let i = 0; i < legacy.length; i++) {
    const key = legacy.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  let order: string[] = [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(legacy.getItem(INDEX_KEY) ?? "[]"));
    if (parsed.success) order = parsed.data;
  } catch {
    // No order kept: they go in as found.
  }
  const rank = (key: string) => order.indexOf(key.slice(PREFIX.length));
  keys.sort((a, b) => rank(a) - rank(b));
  const taken: [string, string][] = [];
  for (const key of keys) {
    const json = legacy.getItem(key);
    if (json !== null) taken.push([key.slice(PREFIX.length), json]);
    legacy.removeItem(key);
  }
  legacy.removeItem(INDEX_KEY);
  return taken;
}

const DATABASE = "outrunner-conversations";
const OBJECTS = "kept";

/** IndexedDB, as strings by key; the database opened on first use. */
export function indexedStorage(factory: IDBFactory): KeptStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const database = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(OBJECTS);
      request.onsuccess = () => {
        const db = request.result;
        // A newer build's upgrade in another tab: let it go ahead.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
    });
    return opening;
  };
  const read = async <T>(op: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const objects = (await database()).transaction(OBJECTS, "readonly").objectStore(OBJECTS);
    return new Promise<T>((resolve, reject) => {
      const request = op(objects);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  // Done when its transaction is: a full disk can abort one after its request
  // succeeded.
  const write = async (op: (objects: IDBObjectStore) => void): Promise<void> => {
    const transaction = (await database()).transaction(OBJECTS, "readwrite");
    op(transaction.objectStore(OBJECTS));
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  };
  return {
    get: async (key) => {
      const value: unknown = await read((objects) => objects.get(key));
      return typeof value === "string" ? value : undefined;
    },
    set: (key, value) => write((objects) => void objects.put(value, key)),
    delete: (key) => write((objects) => void objects.delete(key)),
    keys: async () => (await read((objects) => objects.getAllKeys())).filter((key): key is string => typeof key === "string"),
  };
}

let browserKept: KeptStorage | null | undefined;
function browserStorage(): KeptStorage | null {
  if (browserKept !== undefined) return browserKept;
  try {
    browserKept = typeof indexedDB === "undefined" ? null : indexedStorage(indexedDB);
  } catch {
    browserKept = null; // Storage blocked: nothing is kept, sessions open as before.
  }
  return browserKept;
}

let leaving = false;
/** Write a second after the first change, and at once as the page goes. */
function browserSchedule(flush: () => void): void {
  setTimeout(flush, SAVE_EVERY_MS);
  if (leaving || typeof window === "undefined") return;
  leaving = true;
  const now = () => void KEPT_CONVERSATIONS.flush();
  window.addEventListener("pagehide", now);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") now();
  });
}

/** This browser's kept conversations. */
export const KEPT_CONVERSATIONS = new KeptConversations(browserStorage, browserSchedule);

if (typeof window !== "undefined") {
  try {
    void KEPT_CONVERSATIONS.adopt(window.localStorage);
  } catch {
    // Storage blocked: an older build kept nothing here either.
  }
}

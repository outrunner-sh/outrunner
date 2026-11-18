import { Lru } from "@/lib/client/lru";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";
import { KEPT_CONVERSATIONS } from "@/lib/session/kept-conversations";

/** A session's conversation as last seen here, and where its stream left off. */
export type CachedConversation = {
  events: AgentEvent[];
  /** The resume cursor: the last resumable event's id. */
  lastEventId: string | null;
  /** Event ids already taken in (lib/runtime/conversation-events.ts). */
  seenIds: Set<string>;
  /** The edits of the conversation taken in (ConversationRewound); none
   *  until one is. */
  rewinds?: number;
};

/** Where conversations are kept past the page (lib/session/kept-conversations.ts):
 *  what was shown, without a cursor to resume from. */
export type ConversationStore = {
  load(id: string): Promise<Pick<CachedConversation, "events" | "seenIds"> | undefined>;
  /** The sessions it keeps a conversation for. */
  ids(): Promise<string[]>;
  save(id: string, entry: CachedConversation): void;
  remove(id: string): unknown;
  clear(): unknown;
};

/** How many sessions' conversations are kept: the most recently opened. */
export const CONVERSATIONS_KEPT = 20;

/**
 * Conversations kept for the life of the page, so opening a session shown
 * before (or warmed up from the sidebar) shows its conversation at once and its
 * stream resumes where it left off rather than replaying from the start. The
 * least recently used goes once there are more than `limit`.
 *
 * With a `store`, they outlive the page too: one the page hasn't seen comes
 * from there (`restore`), shown while its stream replays from the start.
 */
export class ConversationCache {
  private readonly entries: Lru<CachedConversation>;
  private readonly store: ConversationStore | null;

  constructor(limit = CONVERSATIONS_KEPT, store: ConversationStore | null = null) {
    this.entries = new Lru(limit);
    this.store = store;
  }

  /** The conversation this page has seen. */
  get(id: string): CachedConversation | undefined {
    return this.entries.get(id);
  }

  /** The conversation this page has seen, or else one kept from before it. */
  async restore(id: string): Promise<CachedConversation | undefined> {
    const seen = this.entries.get(id);
    if (seen || !this.store) return seen;
    const kept = await this.store.load(id);
    // A warm-up's stream may have brought it in meanwhile, and is newer.
    const since = this.entries.get(id);
    if (since || !kept) return since;
    const entry = { ...kept, lastEventId: null };
    this.entries.set(id, entry);
    return entry;
  }

  /** Which of `ids` there is a conversation for, this page's or one kept from
   *  before it: opening any of those shows it at once. */
  async held(ids: readonly string[]): Promise<Set<string>> {
    const held = new Set(ids.filter((id) => this.entries.has(id)));
    if (held.size === ids.length || !this.store) return held;
    for (const id of await this.store.ids()) if (ids.includes(id)) held.add(id);
    return held;
  }

  set(id: string, entry: CachedConversation): void {
    this.entries.set(id, entry);
    this.store?.save(id, entry);
  }

  /** Take in one streamed event, as the session's own stream would. */
  append(id: string, event: AgentEvent, eventId: string): void {
    const entry = this.get(id) ?? { events: [], lastEventId: null, seenIds: new Set<string>() };
    // A copy: the kept Set may be an open page's own, and an id marked seen
    // here would make that page drop the event when its stream delivers it.
    const seenIds = new Set(entry.seenIds);
    this.set(id, {
      events: appendEvent(entry.events, event, eventId, seenIds),
      lastEventId: event.t === "rewind" ? (eventId && eventId !== "0" ? eventId : null) : eventId && eventId !== "0" ? eventId : entry.lastEventId,
      rewinds: event.t === "rewind" ? event.rewinds : entry.rewinds,
      seenIds,
    });
  }

  /** Drop a session's conversation: it was deleted. */
  forget(id: string): void {
    this.entries.delete(id);
    this.store?.remove(id);
  }

  /** Drop every conversation: the user signed out. */
  clear(): void {
    this.entries.clear();
    this.store?.clear();
  }
}

/** The page's conversations, kept in this browser past the page. */
export const CONVERSATIONS = new ConversationCache(CONVERSATIONS_KEPT, KEPT_CONVERSATIONS);

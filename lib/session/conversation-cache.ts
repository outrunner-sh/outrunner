import { Lru } from "@/lib/client/lru";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";

/** A session's conversation as last seen here, and where its stream left off. */
export type CachedConversation = {
  events: AgentEvent[];
  /** The resume cursor: the last resumable event's id. */
  lastEventId: string | null;
  /** Event ids already taken in (lib/runtime/conversation-events.ts). */
  seenIds: Set<string>;
};

/** How many sessions' conversations are kept: the most recently opened. */
export const CONVERSATIONS_KEPT = 20;

/**
 * Conversations kept for the life of the page, so opening a session shown
 * before (or warmed up from the sidebar) shows its conversation at once and its
 * stream resumes where it left off rather than replaying from the start. The
 * least recently used goes once there are more than `limit`.
 */
export class ConversationCache {
  private readonly entries: Lru<CachedConversation>;

  constructor(limit = CONVERSATIONS_KEPT) {
    this.entries = new Lru(limit);
  }

  get(id: string): CachedConversation | undefined {
    return this.entries.get(id);
  }

  set(id: string, entry: CachedConversation): void {
    this.entries.set(id, entry);
  }

  /** Take in one streamed event, as the session's own stream would. */
  append(id: string, event: AgentEvent, eventId: string): void {
    const entry = this.entries.get(id) ?? { events: [], lastEventId: null, seenIds: new Set<string>() };
    this.set(id, {
      events: appendEvent(entry.events, event, eventId, entry.seenIds),
      lastEventId: eventId && eventId !== "0" ? eventId : entry.lastEventId,
      seenIds: entry.seenIds,
    });
  }

  /** Drop a session's conversation: it was deleted. */
  forget(id: string): void {
    this.entries.delete(id);
  }
}

/** The page's conversations. */
export const CONVERSATIONS = new ConversationCache();

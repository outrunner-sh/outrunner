/**
 * Pure event-log helpers for the Conversation projection. Kept in a separate
 * module (no React, no xterm, no browser globals) so it can be unit-tested in
 * Node without dragging the client-only session-client / hook code along.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { promptWithoutAttachments } from "@/lib/runtime/attachments";

/**
 * Append one event to the Conversation log, honoring the invariants from
 * docs/architecture/session-contract.md:
 *
 *   - state events are not resumable; each fresh connect re-emits state, so
 *     we collapse to at-most-one state entry (the newest).
 *   - message events UPSERT by their `uuid`: the agent streams a turn as the
 *     same message re-emitted as it grows (a new SSE id each time), so we
 *     replace the existing entry in place rather than append every partial.
 *   - usage/other events carry a stable SSE id (JSONL byte offset); dedup by id
 *     defensively against a client-side double-subscribe.
 */
export function appendEvent(
  prev: AgentEvent[],
  event: AgentEvent,
  id: string,
  seenIds: Set<string>,
): AgentEvent[] {
  if (event.t === "state") {
    const withoutState = prev.filter((e) => e.t !== "state");
    return [...withoutState, event];
  }
  if (event.t === "message") {
    // Streaming: the same uuid arrives repeatedly, growing. Replace in place so
    // the message renders once and updates, instead of stacking partials.
    const idx = prev.findIndex((e) => e.t === "message" && e.uuid === event.uuid);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = event;
      return next;
    }
    return [...prev, event];
  }
  if (id && seenIds.has(id)) return prev;
  if (id) seenIds.add(id);
  return [...prev, event];
}

/** Plain text of a message event's text blocks, trimmed to match how the agent
 *  records a typed prompt (Claude logs it as a string; the watcher trims it). */
export function messageText(event: AgentEvent): string {
  if (event.t !== "message") return "";
  return event.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/** How many text-bearing user prompts the stream has recorded. Excludes Claude's
 *  tool-result turns, which are logged as role:"user" but carry no prompt text. */
export function userPromptCount(events: AgentEvent[]): number {
  return events.filter((e) => e.t === "message" && e.role === "user" && messageText(e) !== "").length;
}

/** The first prompt the user typed in this conversation, without the header
 *  naming its attachments; null until there is one with text. Skips Claude's
 *  tool-result turns (role "user", no text) and a prompt of only files. */
export function firstUserPrompt(events: AgentEvent[]): string | null {
  for (const event of events) {
    if (event.t !== "message" || event.role !== "user") continue;
    const text = promptWithoutAttachments(messageText(event));
    if (text) return text;
  }
  return null;
}

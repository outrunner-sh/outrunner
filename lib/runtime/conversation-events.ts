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

/** How Claude Code records a turn stopped by Escape: a user message of this
 *  text, ending "]" or " for tool use]". Not a prompt. */
const INTERRUPTED = "[Request interrupted by user";

/** Whether an event is Claude Code's record of a stopped turn. */
export function isInterruption(event: AgentEvent): boolean {
  return event.t === "message" && event.role === "user" && messageText(event).startsWith(INTERRUPTED);
}

/** How Claude Code records a slash command it runs itself (/compact, /model):
 *  user messages of the command and of what it printed, never answered. */
const LOCAL_COMMAND = /^<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/;

/** Whether an event is Claude Code's record of a slash command it ran itself:
 *  no turn for Claude to answer. */
export function isLocalCommand(event: AgentEvent): boolean {
  return event.t === "message" && event.role === "user" && LOCAL_COMMAND.test(messageText(event));
}

/** The command a record of one names ("/compact"), with its arguments; null
 *  for a record of what it printed, or anything else. */
export function localCommandLine(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** The text-bearing user prompts the stream has recorded, in order, each as
 *  typed (without the header naming its attachments). Excludes Claude's
 *  tool-result turns, which are logged as role:"user" but carry no prompt text,
 *  and its records of a stopped turn. */
export function userPrompts(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.t === "message" && e.role === "user" && messageText(e) !== "" && !isInterruption(e))
    .map((e) => promptWithoutAttachments(messageText(e)));
}

/** How many text-bearing user prompts the stream has recorded (userPrompts). */
export function userPromptCount(events: AgentEvent[]): number {
  return userPrompts(events).length;
}

/** The first prompt the user typed in this conversation, without the header
 *  naming its attachments; null until there is one with text. Skips Claude's
 *  tool-result turns (role "user", no text) and a prompt of only files. */
export function firstUserPrompt(events: AgentEvent[]): string | null {
  for (const event of events) {
    if (event.t !== "message" || event.role !== "user" || isInterruption(event)) continue;
    const text = promptWithoutAttachments(messageText(event));
    if (text) return text;
  }
  return null;
}

/** Whether Claude is still working on the current turn — so the moving indicator
 *  shows through the whole thing, not just the gap before the first reply. It's
 *  working while the latest turn is the user's (a fresh prompt or a tool result
 *  it must act on), or while its own latest turn ended on thinking or a tool_use
 *  (more is coming). A turn that ends in text is Claude done and idle — unless
 *  the reply it's part of stopped for a tool call (stopReason "tool_use"): Claude
 *  logs its words before a tool call as a record of their own, the call next. */
export function claudeIsWorking(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t === "state") {
      // A terminated session is never "working", whatever the last turn was.
      if (event.state === "exited" || event.state === "archived") return false;
      continue;
    }
    if (event.t !== "message") continue;
    // A prompt or a tool result awaiting Claude; not the record of a stop, or
    // of a command Claude ran itself.
    if (event.role === "user") return !isInterruption(event) && !isLocalCommand(event);
    const last = event.content[event.content.length - 1];
    if (!last) return false;
    return last.type !== "text" || event.stopReason === "tool_use";
  }
  return false;
}

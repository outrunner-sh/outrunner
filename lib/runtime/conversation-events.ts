/**
 * Pure event-log helpers for the Conversation projection. Kept in a separate
 * module (no React, no xterm, no browser globals) so it can be unit-tested in
 * Node without dragging the client-only session-client / hook code along.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { promptWithoutAttachments } from "@/lib/runtime/attachments";
import { parseRunnerEvents } from "@/lib/missions/events";

/**
 * Append one event to the Conversation log, honoring the invariants from
 * docs/architecture/session-contract.md:
 *
 *   - state events are not resumable; each fresh connect re-emits state, so
 *     we collapse to at-most-one state entry (the newest). Running again (a
 *     reconnect, a reload) or running at last (after starting) is no news:
 *     the entry stays where it was rather than show up mid-conversation.
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
    const at = prev.findIndex((e) => e.t === "state");
    const prior = at >= 0 ? prev[at] : null;
    if (prior?.t === "state" && event.state === "running" && (prior.state === "running" || prior.state === "starting")) {
      const next = [...prev];
      next[at] = event;
      return next;
    }
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

/** The model Claude Code names on a reply it wrote itself rather than a
 *  model: an API error ("API Error: 400 …"), a usage limit, and the like. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** The one reply of its own Claude Code writes that is no failure. */
const NO_RESPONSE = "No response requested.";

/** The model a reply came from, if a model wrote it: none for Claude Code's
 *  own stand-ins, whose `<synthetic>` is no model to show. */
export function replyModel(event: AgentEvent): string | undefined {
  if (event.t !== "message" || event.role !== "assistant") return undefined;
  return event.model && event.model !== SYNTHETIC_MODEL ? event.model : undefined;
}

/** Whether a reply is Claude Code's word that the turn failed (an API error,
 *  a usage limit, a prompt too long) rather than the model's answer. */
export function isErrorReply(event: AgentEvent): boolean {
  return (
    event.t === "message" &&
    event.role === "assistant" &&
    event.model === SYNTHETIC_MODEL &&
    messageText(event) !== NO_RESPONSE
  );
}

/** How Claude Code records a turn stopped by Escape: a user message of this
 *  text, ending "]" or " for tool use]". Not a prompt. */
const INTERRUPTED = "[Request interrupted by user";

/** Whether an event is Claude Code's record of a stopped turn. */
export function isInterruption(event: AgentEvent): boolean {
  return event.t === "message" && event.role === "user" && messageText(event).startsWith(INTERRUPTED);
}

/** How Claude Code records a slash command (/compact, /model, or a custom
 *  command or skill like /review): the command's own record and what it
 *  printed, as user messages. Some are answered; for turn state see
 *  isLocalCommandOutput. */
const LOCAL_COMMAND = /^<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/;

/** Whether an event is Claude Code's record of a slash command, or of what
 *  one printed: a command row in the timeline, not a prompt. Not whether a
 *  turn is over (isLocalCommandOutput says that). */
export function isLocalCommand(event: AgentEvent): boolean {
  return event.t === "message" && event.role === "user" && LOCAL_COMMAND.test(messageText(event));
}

/** How Claude Code records what a slash command it ran itself printed
 *  (/compact's "Compacted", /model's): no turn for Claude to answer. The
 *  command's own record (<command-name>, <command-message>) is not one: a
 *  custom command or skill (/review) is recorded so too, and answered. */
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr|caveat)>/;

/** Whether an event is the record of what a slash command Claude ran itself
 *  printed: the turn is over, nothing more comes. */
export function isLocalCommandOutput(event: AgentEvent): boolean {
  return event.t === "message" && event.role === "user" && LOCAL_COMMAND_OUTPUT.test(messageText(event));
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
    return messageIsWorking(event);
  }
  return false;
}

function messageIsWorking(event: Extract<AgentEvent, { t: "message" }>): boolean {
  // A prompt or a tool result awaiting Claude; not a stop or the output of
  // a command Claude ran itself. Words finish a reply unless a tool follows.
  if (event.role === "user") return !isInterruption(event) && !isLocalCommandOutput(event);
  const last = event.content[event.content.length - 1];
  return !!last && (last.type !== "text" || event.stopReason === "tool_use");
}

/** Runner deliveries absorbed while the agent works are steps of that turn.
 *  At rest they start a turn, just like a prompt. Return stream indices so
 *  timing and plan projection make the same decision. */
export function runnerContinuations(events: AgentEvent[]): Set<number> {
  const indices = new Set<number>();
  let working = false;
  events.forEach((event, i) => {
    if (event.t === "state") {
      if (event.state === "exited" || event.state === "archived") working = false;
      return;
    }
    if (event.t !== "message") return;
    if (working && event.role === "user") {
      const text = messageText(event);
      if (text.includes("<runner_event") && parseRunnerEvents(text).events.length > 0) indices.add(i);
    }
    // A compaction in the middle of a turn doesn't finish it; a typed
    // /compact's local-command output says when that command is done.
    if (!event.compact) working = messageIsWorking(event);
  });
  return indices;
}

/**
 * A session's runs, as the public API reads them: one per prompt it was
 * sent (its first, and each message after), from that prompt to the next.
 * No network here: made from the conversation lib/api/live.ts reads, so an
 * archived session's runs are there too (their ids, as its events', counted
 * from 1 rather than the box's byte offsets).
 *
 * A run's id is its prompt's event id, so it's stable while the box is up,
 * and a message's answer names the run it starts.
 */

import { promptWithoutAttachments } from "@/lib/runtime/attachments";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { isErrorReply, isInterruption, isLocalCommand, messageText } from "@/lib/runtime/conversation-events";
import { lastAssistantText, pendingInput, turnState, type ConversationEntry } from "@/lib/api/conversation";

export type RunStatus = "running" | "needs_input" | "finished" | "cancelled" | "error";

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
};

export type Run = {
  id: string;
  /** Its place among the session's runs, from 1. */
  number: number;
  prompt: string;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  /** What the agent last said, once it's over. */
  result: string | null;
  /** Why it failed (an API error, a usage limit), when it did. */
  error: string | null;
  pending_input: Record<string, unknown> | null;
  usage: Usage;
  /** The events it spans, for `conversation?before_event=` and `stream?after_event=`. */
  first_event: string;
  last_event: string;
};

const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };

/** Whether an event is a prompt someone sent: a user message with words,
 *  not Claude Code's own record (a stopped turn, a slash command, a skill's
 *  instructions) nor a tool's result. */
export function isPrompt(event: AgentEvent): boolean {
  return (
    event.t === "message" &&
    event.role === "user" &&
    !event.meta &&
    messageText(event) !== "" &&
    !isInterruption(event) &&
    !isLocalCommand(event)
  );
}

function add(a: Usage, b: Omit<Usage, "total_tokens">): Usage {
  const sum = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
  return { ...sum, total_tokens: sum.input_tokens + sum.output_tokens + sum.cache_creation_input_tokens + sum.cache_read_input_tokens };
}

/**
 * The tokens `events` spent. A model call's reply can be logged as several
 * assistant records in a row (its words, then each tool call), each with
 * that call's usage so far: they count once, at the most each says. A user
 * record (a tool's result, a prompt) between them starts the next call.
 * `usage` events (an engine that logs usage apart) count as they come.
 */
export function usageOf(events: readonly AgentEvent[]): Usage {
  let total = ZERO;
  let call: Omit<Usage, "total_tokens"> | null = null;
  const flush = () => {
    if (call) total = add(total, call);
    call = null;
  };
  for (const event of events) {
    if (event.t === "usage") {
      total = add(total, event);
      continue;
    }
    if (event.t !== "message") continue;
    if (event.role === "user") {
      flush();
      continue;
    }
    const u = event.usage;
    if (!u) continue;
    call = call
      ? {
          input_tokens: Math.max(call.input_tokens, u.input_tokens),
          output_tokens: Math.max(call.output_tokens, u.output_tokens),
          cache_creation_input_tokens: Math.max(call.cache_creation_input_tokens, u.cache_creation_input_tokens),
          cache_read_input_tokens: Math.max(call.cache_read_input_tokens, u.cache_read_input_tokens),
        }
      : { ...u };
  }
  flush();
  return total;
}

function timestampOf(event: AgentEvent): string | null {
  return event.t === "message" ? event.timestamp : null;
}

/** The session's runs, oldest first. `state` is its state on the box (live
 *  reads only): the newest run is running while the turn is. */
export function runsFrom(entries: readonly ConversationEntry[], state: string | null): Run[] {
  const starts = entries.flatMap((entry, index) => (isPrompt(entry.event) ? [index] : []));
  const all = entries.map((e) => e.event);
  const turn = turnState(all, state);
  return starts.map((start, n) => {
    const slice = entries.slice(start, starts[n + 1] ?? entries.length);
    const events = slice.map((e) => e.event);
    const newest = n === starts.length - 1;
    const prompt = slice[0].event;
    const errorReply = [...events].reverse().find((e) => e.t === "message" && e.role === "assistant");
    let status: RunStatus;
    if (newest && turn === "working") status = "running";
    else if (newest && turn === "needs_input") status = "needs_input";
    else if (events.some(isInterruption)) status = "cancelled";
    else if (errorReply && isErrorReply(errorReply)) status = "error";
    else status = "finished";
    const over = status !== "running" && status !== "needs_input";
    const startedAt = timestampOf(prompt) ?? "";
    const endedAt = over ? ([...events].reverse().map(timestampOf).find((t) => t !== null) ?? startedAt) : null;
    const duration = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
    return {
      id: String(slice[0].id),
      number: n + 1,
      prompt: promptWithoutAttachments(messageText(prompt)),
      status,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
      result: status === "finished" || status === "cancelled" ? lastAssistantText(events) : null,
      error: status === "error" && errorReply ? messageText(errorReply) : null,
      pending_input: status === "needs_input" ? pendingInput(all) : null,
      usage: usageOf(events),
      first_event: String(slice[0].id),
      last_event: String(slice[slice.length - 1].id),
    };
  });
}

/** The session's tokens: every run's, and what was spent before its first
 *  prompt (none, in practice) or outside one, in `total`. */
export function sessionUsage(entries: readonly ConversationEntry[], runs: readonly Run[]): { total: Usage; runs: { id: string; usage: Usage }[] } {
  return { total: usageOf(entries.map((e) => e.event)), runs: runs.map((r) => ({ id: r.id, usage: r.usage })) };
}

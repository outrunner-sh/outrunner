/**
 * A session's conversation as the public API reads it: from its box's event
 * stream (the agent's `/events`, SSE), which has no end and no "caught up"
 * marker, so the read stops once the stream goes quiet after replaying what
 * the log holds. No network here: the caller hands in the stream.
 *
 * Each event's id is the byte offset in the session's log where it was
 * first seen (docs/architecture/session-contract.md), so ids only grow and
 * page backwards with `before_event`. A message Claude streams is re-sent
 * as it grows under the same uuid: it's kept once, where it started, as it
 * is now (as the session page does, lib/runtime/conversation-events.ts).
 */

import { AgentEvent, type ContentBlock } from "@/lib/runtime/agent-protocol";
import { promptWithoutAttachments } from "@/lib/runtime/attachments";
import { claudeIsWorking, isInterruption, messageText } from "@/lib/runtime/conversation-events";
import { pendingQuestion } from "@/lib/runtime/pending-question";
import { pendingSecretRequest } from "@/lib/runtime/pending-secrets";

export type SseFrame = { id: string | null; data: string };

/** How long the box may take to send its first frame: a fresh connect
 *  always opens with the session's state, so silence this long is a box
 *  that isn't answering. */
export const FIRST_FRAME_MS = 8_000;
/** How long the stream may then say nothing before the replay counts as
 *  done: the agent replays the log as fast as it reads it. */
export const QUIET_MS = 800;
/** The longest a read goes on, however busy the stream is. */
export const MAX_READ_MS = 20_000;

/**
 * Read SSE frames from `body` until, after its first, it has said nothing
 * for `quietMs` (or `maxMs` have passed, or it ends), then let it go.
 */
export async function readUntilQuiet(
  body: ReadableStream<Uint8Array>,
  {
    firstMs = FIRST_FRAME_MS,
    quietMs = QUIET_MS,
    maxMs = MAX_READ_MS,
  }: { firstMs?: number; quietMs?: number; maxMs?: number } = {},
): Promise<SseFrame[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  const deadline = Date.now() + maxMs;
  let buffer = "";
  try {
    for (;;) {
      const wait = Math.min(frames.length ? quietMs : firstMs, deadline - Date.now());
      if (wait <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<"quiet">((resolve) => {
        timer = setTimeout(() => resolve("quiet"), wait);
      });
      const next = await Promise.race([reader.read(), quiet]);
      clearTimeout(timer);
      if (next === "quiet" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseFrame(part);
        if (frame) frames.push(frame);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

/** One SSE frame's id and data; null for a comment (a keepalive). */
export function parseFrame(text: string): SseFrame | null {
  let id: string | null = null;
  const data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(":") || line === "") continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, data: data.join("\n") } : null;
}

/** One event of the conversation, with its id (see the module's comment). */
export type ConversationEntry = { id: number; event: AgentEvent };

/**
 * The frames as the conversation they make: messages kept once each, as they
 * are now, in the order they started; usage records as they came. The
 * session's state (running, exited) isn't in the log: it's returned apart.
 */
export function conversationFrom(frames: readonly SseFrame[]): { entries: ConversationEntry[]; state: string | null } {
  const entries: ConversationEntry[] = [];
  const byUuid = new Map<string, number>();
  const seen = new Set<number>();
  let state: string | null = null;
  for (const frame of frames) {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const parsed = AgentEvent.safeParse(raw);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.t === "state") {
      state = event.state;
      continue;
    }
    if (event.t === "rewind") {
      if (event.reset) {
        entries.length = 0;
        byUuid.clear();
        seen.clear();
        continue;
      }
      // An edit cut the log here: what followed its prompt is gone.
      const at = byUuid.get(event.uuid);
      if (at !== undefined) {
        for (const gone of entries.splice(at)) {
          if (gone.event.t === "message") byUuid.delete(gone.event.uuid);
          seen.delete(gone.id);
        }
      }
      continue;
    }
    const id = frame.id !== null && /^\d{1,15}$/.test(frame.id) ? Number(frame.id) : null;
    if (id === null) continue;
    if (event.t === "message") {
      const at = byUuid.get(event.uuid);
      if (at !== undefined) {
        entries[at] = { id: entries[at].id, event };
        continue;
      }
      byUuid.set(event.uuid, entries.length);
    } else if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    entries.push({ id, event });
  }
  return { entries, state };
}

/**
 * An archived conversation (a snapshot's, which keeps no byte offsets) as
 * entries: messages kept once each, as conversationFrom keeps them, each id
 * its place in the log, counted from 1.
 */
export function entriesFromEvents(events: readonly AgentEvent[]): { entries: ConversationEntry[]; state: string | null } {
  const entries: ConversationEntry[] = [];
  const byUuid = new Map<string, number>();
  let state: string | null = null;
  for (const event of events) {
    if (event.t === "state") {
      state = event.state;
      continue;
    }
    if (event.t === "message") {
      const at = byUuid.get(event.uuid);
      if (at !== undefined) {
        entries[at] = { id: entries[at].id, event };
        continue;
      }
      byUuid.set(event.uuid, entries.length);
    }
    entries.push({ id: entries.length + 1, event });
  }
  return { entries, state };
}

/**
 * A page of the conversation, newest last: the `limit` events before
 * `before` (all of them, when not given), and the id to ask for the page
 * before it, or null when this one reaches the start.
 */
export function conversationPage(
  entries: readonly ConversationEntry[],
  { before, limit }: { before?: number; limit: number },
): { events: ConversationEntry[]; hasMore: boolean; nextBefore: number | null } {
  const older = before === undefined ? entries : entries.filter((e) => e.id < before);
  const events = older.slice(Math.max(0, older.length - limit));
  const hasMore = older.length > events.length;
  return { events, hasMore, nextBefore: hasMore && events.length ? events[0].id : null };
}

/** A content block as the API shows it: snake_case, as the rest is. */
function blockJson(block: ContentBlock): Record<string, unknown> {
  if (block.type === "tool_result") return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content };
  return block;
}

/** An event as the API shows it. */
export function eventJson({ id, event }: ConversationEntry): Record<string, unknown> {
  if (event.t === "message") {
    return {
      id: String(id),
      type: "message",
      uuid: event.uuid,
      parent_uuid: event.parentUuid,
      role: event.role,
      ...(event.model && { model: event.model }),
      ...(event.stopReason && { stop_reason: event.stopReason }),
      timestamp: event.timestamp,
      content: event.content.map(blockJson),
    };
  }
  if (event.t === "usage") {
    return {
      id: String(id),
      type: "usage",
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      cache_creation_input_tokens: event.cache_creation_input_tokens,
      cache_read_input_tokens: event.cache_read_input_tokens,
      ...(event.service_tier && { service_tier: event.service_tier }),
    };
  }
  return { id: String(id), type: event.t };
}

/**
 * Where the session's current turn is:
 *
 *   working      the agent is on it
 *   needs_input  it asked a question (ask_user) or for secrets, and waits
 *   idle         the turn is over (or none was asked for), and it waits for a message
 *
 * from the events as the session page reads them (claudeIsWorking,
 * pendingQuestion), so the API and the page agree.
 */
export type TurnState = "working" | "needs_input" | "idle";

export function turnState(events: readonly AgentEvent[], state: string | null = null): TurnState {
  const all = state ? [...events, { t: "state", workspaceId: "", state } as AgentEvent] : [...events];
  if (pendingQuestion(all) || pendingSecretRequest(all)) return "needs_input";
  return claudeIsWorking(all) ? "working" : "idle";
}

/**
 * Whether a prompt was logged after `afterEvent` (at all, for null): a turn
 * can only be over once its prompt is in the log. A session's first prompt
 * is sent just after it's marked ready, and a message is logged a moment
 * after its send returns, so a log without it reads as idle when the turn
 * hasn't begun.
 */
export function promptSince(entries: readonly ConversationEntry[], afterEvent: number | null): boolean {
  return entries.some(
    ({ id, event }) =>
      (afterEvent === null || id > afterEvent) &&
      event.t === "message" &&
      event.role === "user" &&
      messageText(event) !== "" &&
      !isInterruption(event),
  );
}

/** How far the box's clock may be behind the server's for a prompt still
 *  to count as logged after its send began (fenceBefore). */
export const CLOCK_SKEW_MS = 2_000;

/**
 * The fence for waiting on the turn a message starts, read after its send:
 * the id of the last event before the newest prompt that reads as
 * `content` and was logged after the send began (`sentAt`, less
 * CLOCK_SKEW_MS), 0 when it's the first; null when the log doesn't have it
 * yet. The time matters for words sent again ("continue" in a loop): the
 * newest one that reads the same may be the last send's, and a fence before
 * it would let `wait` take that turn's end for this one's. Null is safe
 * (docs/api.md: poll for `working`); a wrong fence isn't.
 */
export function fenceBefore(entries: readonly ConversationEntry[], content: string, sentAt: number): number | null {
  const wanted = content.trim();
  for (let i = entries.length - 1; i >= 0; i--) {
    const { event } = entries[i];
    if (event.t !== "message" || event.role !== "user" || isInterruption(event)) continue;
    // A message sent with files names them after its words (promptWithAttachments).
    if (promptWithoutAttachments(messageText(event)) !== wanted) continue;
    const at = Date.parse(event.timestamp);
    // The newest that reads the same is from before this send: this one
    // isn't in the log yet.
    if (!Number.isFinite(at) || at < sentAt - CLOCK_SKEW_MS) return null;
    return i > 0 ? entries[i - 1].id : 0;
  }
  return null;
}

/**
 * Whether a wait is over, from the live conversation: the turn isn't
 * working, and, when the wait is fenced (`after_event` given, or a session
 * the API started, whose first prompt follows its ready), the prompt it
 * waits on is in the log past the fence. That holds for a question too: one
 * asked before the fence still shows until the answer sent after it is
 * logged, and handing it back would answer the wait with the old question.
 */
export function turnSettled(
  entries: readonly ConversationEntry[],
  state: string | null,
  { fenced, afterEvent }: { fenced: boolean; afterEvent: number | null },
): boolean {
  if (turnState(entries.map((e) => e.event), state) === "working") return false;
  return !fenced || promptSince(entries, afterEvent);
}

/** What the agent is waiting on, for a turn that needs input. */
export function pendingInput(events: readonly AgentEvent[]): Record<string, unknown> | null {
  const all = [...events];
  const question = pendingQuestion(all);
  if (question) return { type: "question", tool_use_id: question.toolUseId, questions: question.questions };
  const secrets = pendingSecretRequest(all);
  if (secrets) return { type: "secrets", tool_use_id: secrets.toolUseId, reason: secrets.reason, keys: secrets.keys };
  return null;
}

/** The last thing the agent said, for a turn that's over. */
export function lastAssistantText(events: readonly AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t !== "message" || event.role !== "assistant") continue;
    const text = event.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return null;
}

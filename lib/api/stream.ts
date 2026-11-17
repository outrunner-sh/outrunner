/**
 * A session's live stream (GET /workspaces/{id}/stream), the part with no
 * network: the box's event frames (lib/api/conversation.ts parseFrame) made
 * into the API's stream events, as they come.
 *
 *   status       where the turn is: working, needs_input, idle (no id)
 *   prompt       a run began: its prompt (lib/api/runs.ts)
 *   thinking     what the agent thought, where its log says: as `assistant`
 *   assistant    what the agent said: each record's words, or what a growing
 *                one added since it was last sent
 *   tool_call    a tool it called (running), then its result (completed)
 *   needs_input  it asked a question or for secrets, and waits
 *   result       a run ended: its status, last words, duration and tokens
 *
 * Every event but `status` carries the id of the log event it came from,
 * which a reconnect sends back (Last-Event-ID, or `after_event`) to go on
 * after it. The box replays its whole log on connect: what came at or
 * before the start (`after`) is read, for the turn's state, but not sent.
 */

import { conversationFrom, pendingInput, turnState, type ConversationEntry, type SseFrame } from "@/lib/api/conversation";
import { isPrompt, runsFrom, type Run } from "@/lib/api/runs";
import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { promptWithoutAttachments } from "@/lib/runtime/attachments";
import { messageText } from "@/lib/runtime/conversation-events";

export type StreamEvent = { event: string; id: string | null; data: Record<string, unknown> };

/** One stream event as SSE text. */
export function sseText({ event, id, data }: StreamEvent): string {
  return `${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A stream's start, from Last-Event-ID or `after_event`: the log event to
 *  go on after, or null to start at the newest run; undefined for one that
 *  isn't an event's id. The header wins, as a browser's EventSource sends it. */
export function streamStart(header: string | null, query: string | null): number | null | undefined {
  const value = header ?? query;
  if (value === null || value === "") return null;
  return /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

function wordsOf(event: AgentEvent): string {
  if (event.t !== "message") return "";
  return event.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function thoughtsOf(event: AgentEvent): string {
  if (event.t !== "message") return "";
  return event.content
    .filter((b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * Feeds the box's frames in, and answers the stream events each makes.
 * `after`: the log event to go on after (null: from the newest run's prompt,
 * known once the replay is in, so `backlog` sends it). `run`: only that run's
 * events, ending with its `result`; named by its id, or by its number (a run
 * not yet begun, as a session just made has: nothing is sent until it is).
 */
export class StreamProjector {
  private frames: SseFrame[] = [];
  private entries: ConversationEntry[] = [];
  private state: string | null = null;
  /** What each message has had sent: its thoughts, its words, its tool calls. */
  private sentThoughts = new Map<string, number>();
  private sentWords = new Map<string, number>();
  private sentTools = new Set<string>();
  private doneTools = new Set<string>();
  private turn: string | null = null;
  /** The newest run when `turn` was last read. */
  private turnRun: string | null = null;
  private asked: string | null = null;
  private ended = new Set<string>();
  private cutoff: number;
  private live = false;
  /** The run it follows ended: nothing more is sent. */
  finished = false;

  private readonly after: number | null;
  private readonly run?: string | { number: number };

  constructor(after: number | null, run?: string | { number: number }) {
    this.after = after;
    this.run = run;
    this.cutoff = after ?? Number.POSITIVE_INFINITY;
  }

  /** The id of the run it follows, once it's known: null while one named by
   *  number hasn't begun. */
  private runId(runs: readonly Run[]): string | null {
    const run = this.run;
    if (typeof run === "string") return run;
    return run ? (runs.find((r) => r.number === run.number)?.id ?? null) : null;
  }

  /** Take a frame. Until `backlog` is called it's kept, to be read then. */
  feed(frame: SseFrame): StreamEvent[] {
    this.frames.push(frame);
    if (!this.live) return [];
    this.apply(frame);
    return this.project();
  }

  /** The whole log read again, as conversationFrom reads it. */
  private readAll() {
    const read = conversationFrom(this.frames);
    this.entries = read.entries;
    this.state = read.state ?? this.state;
  }

  /** One live frame added to what's read: a message (new, or grown under
   *  its uuid), a usage record, the session's state; a rewind, which can
   *  take events out, has the log read again whole. */
  private apply(frame: SseFrame) {
    if (/"t"\s*:\s*"rewind"/.test(frame.data)) return this.readAll();
    const read = conversationFrom([frame]);
    this.state = read.state ?? this.state;
    for (const entry of read.entries) {
      const event = entry.event;
      const at = event.t === "message" ? this.entries.findIndex((e) => e.event.t === "message" && e.event.uuid === event.uuid) : -1;
      if (at !== -1) this.entries[at] = { id: this.entries[at].id, event };
      else if (event.t === "message" || !this.entries.some((e) => e.id === entry.id)) this.entries.push(entry);
    }
  }

  /** The replay is in: where the stream starts is known, and what's past it
   *  is sent. */
  backlog(): StreamEvent[] {
    this.readAll();
    this.live = true;
    if (this.after === null) {
      const runs = runsFrom(this.entries, this.state);
      const from = this.run ? runs.find((r) => r.id === this.runId(runs)) : runs.at(-1);
      // Before the run's prompt: it's sent as the run's start.
      this.cutoff = from ? Number(from.id) - 1 : (this.entries.at(-1)?.id ?? -1);
    }
    // What the start leaves out counts as sent, so a later growth of one of
    // its messages sends only what's new.
    for (const { id, event } of this.entries) {
      if (id > this.cutoff || event.t !== "message") continue;
      this.sentThoughts.set(event.uuid, thoughtsOf(event).length);
      this.sentWords.set(event.uuid, wordsOf(event).length);
      for (const block of event.content) {
        if (block.type === "tool_use") this.sentTools.add(block.id);
        if (block.type === "tool_result") this.doneTools.add(block.toolUseId);
      }
    }
    return this.project();
  }

  private inRun(id: number): boolean {
    if (!this.run) return true;
    const runs = runsFrom(this.entries, this.state);
    const want = this.runId(runs);
    const at = runs.findIndex((r) => r.id === want);
    if (at === -1) return false;
    const next = runs[at + 1];
    return id >= Number(want) && (!next || id < Number(next.id));
  }

  private project(): StreamEvent[] {
    if (this.finished) return [];
    const out: StreamEvent[] = [];
    const runs = runsFrom(this.entries, this.state);
    const toolNames = new Map<string, { name: string; input: unknown }>();
    for (const { id, event } of this.entries) {
      if (event.t !== "message") continue;
      for (const block of event.content) if (block.type === "tool_use") toolNames.set(block.id, { name: block.name, input: block.input });
      if (id <= this.cutoff || !this.inRun(id)) continue;
      const sid = String(id);
      if (isPrompt(event) && !this.sentWords.has(event.uuid)) {
        // The run before it ended here: its result goes first.
        out.push(...this.results(id));
        this.sentWords.set(event.uuid, 0);
        out.push({ event: "prompt", id: sid, data: { run_id: sid, run_number: runs.find((r) => r.id === sid)?.number ?? null, text: promptWithoutAttachments(messageText(event)), timestamp: event.timestamp } });
        continue;
      }
      if (event.role === "assistant") {
        const thoughts = thoughtsOf(event);
        const thought = this.sentThoughts.get(event.uuid) ?? 0;
        if (thoughts.length > thought) {
          out.push({ event: "thinking", id: sid, data: { uuid: event.uuid, text: thoughts.slice(thought) } });
          this.sentThoughts.set(event.uuid, thoughts.length);
        }
        const words = wordsOf(event);
        const sent = this.sentWords.get(event.uuid) ?? 0;
        if (words.length > sent) {
          out.push({ event: "assistant", id: sid, data: { uuid: event.uuid, text: words.slice(sent) } });
          this.sentWords.set(event.uuid, words.length);
        }
      }
      for (const block of event.content) {
        if (block.type === "tool_use" && !this.sentTools.has(block.id)) {
          this.sentTools.add(block.id);
          out.push({ event: "tool_call", id: sid, data: { call_id: block.id, name: block.name, status: "running", args: block.input } });
        }
        if (block.type === "tool_result" && !this.doneTools.has(block.toolUseId)) {
          this.doneTools.add(block.toolUseId);
          const call = toolNames.get(block.toolUseId);
          out.push({
            event: "tool_call",
            id: sid,
            data: { call_id: block.toolUseId, name: call?.name ?? null, status: "completed", ...(call && { args: call.input }), result: block.content, ...(block.isError && { is_error: true }) },
          });
        }
      }
    }
    out.push(...this.turnEvents());
    return out;
  }

  /** `status` when the turn moves, `needs_input` when it asks, and `result`
   *  for each run that ended since. */
  private turnEvents(): StreamEvent[] {
    const out: StreamEvent[] = [];
    const events = this.entries.map((e) => e.event);
    const turn = turnState(events, this.state);
    const runs = runsFrom(this.entries, this.state);
    const current = runs.at(-1);
    // On a run's stream, its run beginning while the turn goes on (a
    // message sent to a working session) is a move too.
    if (turn !== this.turn || (this.run && current?.id !== this.turnRun)) {
      // Kept as it moves, but told on a run's stream only for that run
      // (and where it stands at the start).
      const told = !this.run || current?.id === this.runId(runs) || this.turn === null;
      this.turn = turn;
      this.turnRun = current?.id ?? null;
      if (told) out.push({ event: "status", id: null, data: { state: turn, run_id: current?.id ?? null, run_number: current?.number ?? null } });
    }
    const pending = turn === "needs_input" ? pendingInput(events) : null;
    const askedNow = pending ? String(pending.tool_use_id) : null;
    if (askedNow && askedNow !== this.asked && current && Number(current.last_event) > this.cutoff && this.inRun(Number(current.last_event))) {
      out.push({ event: "needs_input", id: current.last_event, data: { run_id: current.id, run_number: current.number, pending_input: pending } });
    }
    this.asked = askedNow;
    out.push(...this.results(Number.POSITIVE_INFINITY));
    return out;
  }

  /** A `result` for each run that ended before the event `before`, not yet sent. */
  private results(before: number): StreamEvent[] {
    const out: StreamEvent[] = [];
    const runs = runsFrom(this.entries, this.state);
    const want = this.run ? this.runId(runs) : null;
    for (const run of runs) {
      const over = run.status !== "running" && run.status !== "needs_input";
      if (!over || Number(run.id) >= before || this.ended.has(run.id) || Number(run.last_event) <= this.cutoff) continue;
      if (this.run && run.id !== want) continue;
      this.ended.add(run.id);
      out.push({
        event: "result",
        id: run.last_event,
        data: { run_id: run.id, run_number: run.number, status: run.status, text: run.result, error: run.error, duration_ms: run.duration_ms, usage: run.usage },
      });
      if (this.run) this.finished = true;
    }
    return out;
  }
}

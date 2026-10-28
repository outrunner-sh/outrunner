/**
 * Reading a box's conversation stream on the server, a little at a time: from
 * where the last read left off, until nothing new comes for a moment. The
 * agent's SSE never ends on its own (it waits for the next event), so a read
 * is bounded by quiet, by time and by size; what it got is folded and its
 * cursor kept (lib/session/watch.ts).
 */

import { AgentEvent } from "@/lib/runtime/agent-protocol";

export type StreamRead = {
  events: AgentEvent[];
  /** The last event's id (a JSONL byte offset): where the next read starts. */
  cursor: number;
  /** Stopped by the time or size bound rather than by quiet: more is waiting. */
  partial: boolean;
};

/**
 * Parse SSE text into frames, leaving an unfinished one for the next chunk.
 * Comments (the agent's `: keepalive`) are skipped; a frame with no `data:`
 * is dropped.
 */
export function parseSse(buffer: string): { frames: Array<{ id: number | null; data: string }>; rest: string } {
  const frames: Array<{ id: number | null; data: string }> = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let id: number | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id" && /^\d{1,15}$/.test(value)) id = Number(value);
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) frames.push({ id, data: data.join("\n") });
  }
  return { frames, rest };
}

/** The events of some frames, and the furthest cursor they carry. A frame the
 *  schema doesn't know is skipped, as the browser skips it. */
export function framesToEvents(
  frames: Array<{ id: number | null; data: string }>,
  cursor: number,
): { events: AgentEvent[]; cursor: number } {
  const events: AgentEvent[] = [];
  let at = cursor;
  for (const frame of frames) {
    let json: unknown;
    try {
      json = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const parsed = AgentEvent.safeParse(json);
    if (parsed.success) events.push(parsed.data);
    // Never backwards: the connect-time state event carries 0.
    if (frame.id !== null && frame.id > at) at = frame.id;
  }
  return { events, cursor: at };
}

export type ReadLimits = {
  /** Done once nothing new comes for this long. */
  quietMs: number;
  /** And at the latest after this long. */
  maxMs: number;
  /** Or this many bytes: a long log is read over several ticks. */
  maxBytes: number;
};

export const READ_LIMITS: ReadLimits = { quietMs: 1_500, maxMs: 8_000, maxBytes: 4 * 1024 * 1024 };

/** Read `url` (the agent's SSE, from `cursor`) within `limits`. Throws when
 *  the box can't be reached or answers with an error. */
export async function readStream(
  url: string,
  cursor: number,
  limits: ReadLimits = READ_LIMITS,
  fetchImpl: typeof fetch = fetch,
): Promise<StreamRead> {
  const abort = new AbortController();
  // Which bound ended the read: quiet is the stream caught up; the deadline
  // or the size, more waiting.
  const end: { why: "quiet" | "deadline" | "size" | null } = { why: null };
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // The reader is let go of too, not only the request: a read under way then
  // ends at once, whatever the body does with the abort.
  const stop = (why: "quiet" | "deadline") => {
    end.why ??= why;
    abort.abort();
    void reader?.cancel().catch(() => {});
  };
  const deadline = setTimeout(() => stop("deadline"), limits.maxMs);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const hush = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => stop("quiet"), limits.quietMs);
  };
  let buffer = "";
  let at = cursor;
  const events: AgentEvent[] = [];
  try {
    // Only the deadline bounds the connect: a box can take a while to answer.
    const response = await fetchImpl(url, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal: abort.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The box's stream answered ${response.status}`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    // Open, and nothing new comes (a resume with nothing since): caught up.
    hush();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (end.why) break;
        if (done) break;
        hush();
        bytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSse(buffer);
        buffer = rest;
        const read = framesToEvents(frames, at);
        events.push(...read.events);
        at = read.cursor;
        if (bytes >= limits.maxBytes) {
          end.why = "size";
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    // A bound ending the read is how a read ends; anything else is the box.
    if (!end.why) throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(quiet);
  }
  return { events, cursor: at, partial: end.why === "deadline" || end.why === "size" };
}

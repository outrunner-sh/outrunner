import assert from "node:assert/strict";
import { test } from "node:test";

import { framesToEvents, parseSse, readStream } from "@/lib/session/event-stream";

const message = (uuid: string) =>
  JSON.stringify({ t: "message", uuid, parentUuid: null, role: "assistant", timestamp: "2026-10-28T10:00:00Z", content: [{ type: "text", text: "hi" }] });

test("SSE frames are parsed across chunks, comments skipped, an unfinished one left over", () => {
  const { frames, rest } = parseSse(`: keepalive\n\nid: 120\ndata: ${message("a")}\n\nid: 240\ndata: {"t":"mess`);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 120);
  assert.match(rest, /^id: 240/);
});

test("the cursor is the furthest id, never backwards, and an unknown frame is skipped", () => {
  const { events, cursor } = framesToEvents(
    [
      { id: 0, data: JSON.stringify({ t: "state", workspaceId: "w", state: "running" }) },
      { id: 300, data: message("a") },
      { id: 310, data: '{"t":"something-new"}' },
      { id: 200, data: "not json" },
    ],
    100,
  );
  assert.equal(events.length, 2);
  assert.equal(cursor, 310);
});

/** A fetch whose stream sends `chunks` (with pauses, in ms) and then stays open. */
function streaming(chunks: Array<string | number>): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          if (typeof chunk === "number") await new Promise((resolve) => setTimeout(resolve, chunk));
          else controller.enqueue(new TextEncoder().encode(chunk));
        }
        // Open until the reader lets go, as the agent's stream is.
        await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve()));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

test("a read ends at the first quiet moment, caught up", async () => {
  const read = await readStream(
    "https://box/events",
    0,
    { quietMs: 50, maxMs: 2_000, maxBytes: 1_000_000 },
    streaming([`id: 10\ndata: ${message("a")}\n\n`, 10, `id: 20\ndata: ${message("b")}\n\n`]),
  );
  assert.equal(read.events.length, 2);
  assert.equal(read.cursor, 20);
  assert.equal(read.partial, false);
});

test("a read cut off by its size bound says more is waiting", async () => {
  const read = await readStream(
    "https://box/events",
    0,
    { quietMs: 500, maxMs: 2_000, maxBytes: 10 },
    streaming([`id: 10\ndata: ${message("a")}\n\n`, `id: 20\ndata: ${message("b")}\n\n`]),
  );
  assert.equal(read.cursor, 10);
  assert.equal(read.partial, true);
});

test("a box that answers with an error throws", async () => {
  const failing = (async () => new Response("no", { status: 502 })) as typeof fetch;
  await assert.rejects(readStream("https://box/events", 0, { quietMs: 50, maxMs: 500, maxBytes: 100 }, failing), /502/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SseFrame } from "@/lib/api/conversation";
import { sseText, StreamProjector, streamStart, type StreamEvent } from "@/lib/api/stream";

const text = (t: string) => ({ type: "text", text: t });
const message = (uuid: string, role: "user" | "assistant", content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ t: "message", uuid, parentUuid: null, role, timestamp: "2026-11-14T10:00:00Z", content, ...extra });
const frame = (id: number | null, data: unknown): SseFrame => ({ id: id === null ? null : String(id), data: JSON.stringify(data) });
const state = (s: string) => frame(null, { t: "state", workspaceId: "w", state: s });
const kinds = (events: StreamEvent[]) => events.map((e) => (e.event === "status" ? `status:${e.data.state}` : e.event));

const history = [
  state("running"),
  frame(10, message("p1", "user", [text("Make the header sticky")])),
  frame(20, message("a1", "assistant", [text("Done.")], { stopReason: "end_turn" })),
  frame(30, message("p2", "user", [text("Also on mobile")])),
  frame(40, message("a2", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }], { stopReason: "tool_use" })),
];

function replay(projector: StreamProjector, frames: SseFrame[]): StreamEvent[] {
  for (const f of frames) assert.deepEqual(projector.feed(f), []);
  return projector.backlog();
}

test("with no start, it starts at the newest run's prompt", () => {
  const out = replay(new StreamProjector(null), history);
  assert.deepEqual(kinds(out), ["prompt", "tool_call", "status:working"]);
  assert.deepEqual(out[0].data, { run_id: "30", text: "Also on mobile", timestamp: "2026-11-14T10:00:00Z" });
  assert.equal(out[0].id, "30");
  assert.deepEqual(out[1].data, { call_id: "t1", name: "Bash", status: "running", args: { command: "pnpm test" } });
});

test("after an event, it sends what came after it, and only that", () => {
  const out = replay(new StreamProjector(20), history);
  assert.deepEqual(kinds(out), ["prompt", "tool_call", "status:working"]);
  assert.deepEqual(kinds(replay(new StreamProjector(0), history)), ["prompt", "assistant", "result", "prompt", "tool_call", "status:working"]);
});

test("live frames follow: words, a tool's result, then the run's result", () => {
  const projector = new StreamProjector(null);
  replay(projector, history);
  const done = projector.feed(frame(50, message("u1", "user", [{ type: "tool_result", toolUseId: "t1", content: "12 passed" }])));
  assert.deepEqual(done.map((e) => [e.event, e.data.status]), [["tool_call", "completed"]]);
  assert.equal(done[0].data.result, "12 passed");
  assert.equal(done[0].data.name, "Bash");
  const words = projector.feed(frame(60, message("a3", "assistant", [text("Mobile too.")], { stopReason: "end_turn" })));
  assert.deepEqual(kinds(words), ["assistant", "status:idle", "result"]);
  assert.deepEqual(words[0].data, { uuid: "a3", text: "Mobile too." });
  const result = words[2];
  assert.equal(result.id, "60");
  assert.equal(result.data.run_id, "30");
  assert.equal(result.data.status, "finished");
  assert.equal(result.data.text, "Mobile too.");
});

test("a message that grows sends only what it added", () => {
  const projector = new StreamProjector(null);
  replay(projector, [state("running"), frame(10, message("p", "user", [text("hi")]))]);
  assert.deepEqual(projector.feed(frame(20, message("a", "assistant", [text("Hel")]))).filter((e) => e.event === "assistant").map((e) => e.data.text), ["Hel"]);
  assert.deepEqual(projector.feed(frame(20, message("a", "assistant", [text("Hello there")]))).filter((e) => e.event === "assistant").map((e) => e.data.text), ["lo there"]);
});

test("a run's stream sends that run alone, and ends with its result", () => {
  const projector = new StreamProjector(null, "10");
  const out = replay(projector, history);
  assert.deepEqual(kinds(out), ["prompt", "assistant", "status:working", "result"]);
  assert.equal(projector.finished, true);
  assert.deepEqual(projector.feed(frame(60, message("a3", "assistant", [text("later")]))), []);
});

test("a question it asks is sent once, as needs_input", () => {
  const projector = new StreamProjector(null);
  replay(projector, [state("running"), frame(10, message("p", "user", [text("set it up")]))]);
  const ask = { type: "tool_use", id: "q1", name: "mcp__outrunner__ask_user", input: { questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] } };
  const out = projector.feed(frame(20, message("a", "assistant", [ask], { stopReason: "tool_use" })));
  assert.deepEqual(kinds(out), ["tool_call", "status:needs_input", "needs_input"]);
  const asked = out.find((e) => e.event === "needs_input")!;
  assert.equal(asked.data.run_id, "10");
  assert.equal((asked.data.pending_input as { type: string }).type, "question");
  assert.deepEqual(projector.feed(state("running")).filter((e) => e.event === "needs_input"), []);
});

test("a start is an event's id, from the header first", () => {
  assert.equal(streamStart(null, null), null);
  assert.equal(streamStart("42", "7"), 42);
  assert.equal(streamStart(null, "7"), 7);
  assert.equal(streamStart("x", null), undefined);
});

test("an event is SSE text, with its id when it has one", () => {
  assert.equal(sseText({ event: "assistant", id: "20", data: { text: "hi" } }), 'id: 20\nevent: assistant\ndata: {"text":"hi"}\n\n');
  assert.equal(sseText({ event: "heartbeat", id: null, data: {} }), "event: heartbeat\ndata: {}\n\n");
});

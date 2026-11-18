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
  assert.deepEqual(out[0].data, { run_id: "30", run_number: 2, text: "Also on mobile", timestamp: "2026-11-14T10:00:00Z" });
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

test("what it thought is sent as thinking, before its words, and grows apart from them", () => {
  const projector = new StreamProjector(null);
  replay(projector, [state("running"), frame(10, message("p", "user", [text("hi")]))]);
  const first = projector.feed(frame(20, message("a", "assistant", [{ type: "thinking", text: "Look at" }])));
  assert.deepEqual(kinds(first), ["thinking"]);
  assert.deepEqual(first[0], { event: "thinking", id: "20", data: { uuid: "a", text: "Look at" } });
  const grown = projector.feed(frame(20, message("a", "assistant", [{ type: "thinking", text: "Look at the header." }, text("Hello")])));
  assert.deepEqual(grown.filter((e) => e.id !== null && e.event !== "result").map((e) => [e.event, e.data.text]), [["thinking", " the header."], ["assistant", "Hello"]]);
  // A thinking block with nothing logged in it (Claude's, often) sends nothing.
  assert.deepEqual(projector.feed(frame(30, message("b", "assistant", [{ type: "thinking" }]))).filter((e) => e.event === "thinking"), []);
});

test("what it thought before the start isn't sent again; only what it adds", () => {
  const frames = [state("running"), frame(10, message("p", "user", [text("hi")])), frame(20, message("a", "assistant", [{ type: "thinking", text: "Look" }]))];
  const projector = new StreamProjector(20);
  assert.deepEqual(kinds(replay(projector, frames)), ["status:working"]);
  // The log read again from the top (a reset), the message logged anew past the start.
  projector.feed(frame(null, { t: "rewind", at: 0, uuid: "p", rewinds: 1, reset: true }));
  const grown = projector.feed(frame(25, message("a", "assistant", [{ type: "thinking", text: "Look closer" }])));
  assert.deepEqual(grown.filter((e) => e.event === "thinking").map((e) => e.data.text), [" closer"]);
});

test("a run's stream sends that run alone, and ends with its result", () => {
  const projector = new StreamProjector(null, "10");
  const out = replay(projector, history);
  assert.deepEqual(kinds(out), ["prompt", "assistant", "status:working", "result"]);
  assert.equal(projector.finished, true);
  assert.deepEqual(projector.feed(frame(60, message("a3", "assistant", [text("later")]))), []);
});

test("a run named by its number is the same run as by its id", () => {
  const byNumber = replay(new StreamProjector(null, { number: 1 }), history);
  assert.deepEqual(byNumber, replay(new StreamProjector(null, "10"), history));
  assert.equal(byNumber.at(-1)?.data.run_number, 1);
});

test("a run named by its number that hasn't begun is waited for, then followed to its result", () => {
  const projector = new StreamProjector(null, { number: 3 });
  const before = replay(projector, history);
  // Only where the session's turn is: nothing of the runs before it.
  assert.deepEqual(kinds(before), ["status:working"]);
  assert.equal(before[0].data.run_number, 2);
  assert.deepEqual(projector.feed(frame(50, message("u1", "user", [{ type: "tool_result", toolUseId: "t1", content: "ok" }]))), []);
  assert.deepEqual(projector.feed(frame(60, message("a3", "assistant", [text("Mobile too.")], { stopReason: "end_turn" }))), []);
  const started = projector.feed(frame(70, message("p3", "user", [text("Now the footer")])));
  assert.deepEqual(kinds(started), ["prompt", "status:working"]);
  assert.deepEqual([started[0].data.run_id, started[0].data.run_number], ["70", 3]);
  const done = projector.feed(frame(80, message("a4", "assistant", [text("Footer done.")], { stopReason: "end_turn" })));
  assert.deepEqual(kinds(done), ["assistant", "status:idle", "result"]);
  assert.deepEqual([done[2].data.run_id, done[2].data.run_number, done[2].data.status], ["70", 3, "finished"]);
  assert.equal(projector.finished, true);
});

test("a run named by its number, sent while the turn goes on, is told it's working when it begins", () => {
  const projector = new StreamProjector(null, { number: 3 });
  assert.deepEqual(kinds(replay(projector, history)), ["status:working"]);
  const started = projector.feed(frame(50, message("p3", "user", [text("Change of plan: the footer")])));
  assert.deepEqual(kinds(started), ["prompt", "status:working"]);
  assert.equal(started[1].data.run_number, 3);
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

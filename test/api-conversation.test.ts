import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversationFrom,
  conversationPage,
  entriesFromEvents,
  eventJson,
  fenceBefore,
  lastAssistantText,
  parseFrame,
  pendingInput,
  promptSince,
  readUntilQuiet,
  turnSettled,
  turnState,
} from "@/lib/api/conversation";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { promptWithAttachments } from "@/lib/runtime/attachments";

function message(uuid: string, role: "user" | "assistant", content: unknown[], extra: Record<string, unknown> = {}) {
  return { t: "message", uuid, parentUuid: null, role, timestamp: "2026-11-01T00:00:00Z", content, ...extra };
}
const text = (t: string) => ({ type: "text", text: t });
const frame = (id: number, data: unknown) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;

/** A stream that sends `chunks`, then stays open saying nothing. */
function openStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

test("SSE frames: id and data, comments skipped", () => {
  assert.deepEqual(parseFrame("id: 42\ndata: {\"a\":1}"), { id: "42", data: "{\"a\":1}" });
  assert.equal(parseFrame(": keepalive"), null);
  assert.deepEqual(parseFrame("data: a\ndata: b"), { id: null, data: "a\nb" });
});

test("a read ends once the stream goes quiet, though it never closes", async () => {
  const started = Date.now();
  const frames = await readUntilQuiet(
    openStream([frame(0, { t: "state", workspaceId: "w", state: "running" }), frame(120, message("m1", "user", [text("hi")]))]),
    { quietMs: 50, firstMs: 1_000 },
  );
  assert.equal(frames.length, 2);
  assert.ok(Date.now() - started < 1_000);
});

test("a frame split across chunks is read whole", async () => {
  const whole = frame(9, message("m1", "user", [text("hello")]));
  const frames = await readUntilQuiet(openStream([whole.slice(0, 10), whole.slice(10)]), { quietMs: 50 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, "9");
});

test("a streamed message is kept once, where it started, as it is now", () => {
  const { entries, state } = conversationFrom([
    { id: "0", data: JSON.stringify({ t: "state", workspaceId: "w", state: "running" }) },
    { id: "100", data: JSON.stringify(message("u1", "user", [text("do it")])) },
    { id: "200", data: JSON.stringify(message("a1", "assistant", [text("Work")])) },
    { id: "260", data: JSON.stringify({ t: "usage", input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) },
    { id: "300", data: JSON.stringify(message("a1", "assistant", [text("Working on it")])) },
    { id: "nope", data: "{}" },
  ]);
  assert.equal(state, "running");
  assert.deepEqual(entries.map((e) => e.id), [100, 200, 260]);
  assert.equal(lastAssistantText(entries.map((e) => e.event)), "Working on it");
});

test("pages go back from before_event, newest last", () => {
  const entries = [1, 2, 3, 4, 5].map((id) => ({ id, event: message(`m${id}`, "user", [text(String(id))]) as AgentEvent }));
  const latest = conversationPage(entries, { limit: 2 });
  assert.deepEqual(latest.events.map((e) => e.id), [4, 5]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextBefore, 4);
  const older = conversationPage(entries, { before: 4, limit: 2 });
  assert.deepEqual(older.events.map((e) => e.id), [2, 3]);
  const first = conversationPage(entries, { before: 2, limit: 2 });
  assert.deepEqual(first.events.map((e) => e.id), [1]);
  assert.equal(first.hasMore, false);
  assert.equal(first.nextBefore, null);
});

test("an archived conversation counts its events from 1", () => {
  const { entries } = entriesFromEvents([
    message("u1", "user", [text("a")]) as AgentEvent,
    message("a1", "assistant", [text("b")]) as AgentEvent,
    message("a1", "assistant", [text("bc")]) as AgentEvent,
  ]);
  assert.deepEqual(entries.map((e) => e.id), [1, 2]);
});

test("the turn: working, needing input, or idle, as the session page reads it", () => {
  const prompt = message("u1", "user", [text("fix it")]) as AgentEvent;
  assert.equal(turnState([prompt]), "working");
  const toolCall = message("a1", "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]) as AgentEvent;
  assert.equal(turnState([prompt, toolCall]), "working");
  const done = message("a2", "assistant", [text("Done.")], { stopReason: "end_turn" }) as AgentEvent;
  assert.equal(turnState([prompt, done]), "idle");
  assert.equal(turnState([prompt], "exited"), "idle");
  const ask = message("a3", "assistant", [
    { type: "tool_use", id: "q1", name: "mcp__outrunner__ask_user", input: { questions: [{ question: "Which?", options: ["A", "B"] }] } },
  ]) as AgentEvent;
  assert.equal(turnState([prompt, ask]), "needs_input");
  assert.deepEqual(pendingInput([prompt, ask]), {
    type: "question",
    tool_use_id: "q1",
    questions: [{ question: "Which?", options: [{ label: "A", description: undefined }, { label: "B", description: undefined }] }],
  });
});

test("events are snake_case, tool results with their call's id", () => {
  const event = message("u2", "user", [{ type: "tool_result", toolUseId: "t1", content: "ok" }]) as AgentEvent;
  assert.deepEqual(eventJson({ id: 7, event }), {
    id: "7",
    type: "message",
    uuid: "u2",
    parent_uuid: null,
    role: "user",
    timestamp: "2026-11-01T00:00:00Z",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  });
});

test("a failed tool result carries is_error", () => {
  const event = message("u3", "user", [{ type: "tool_result", toolUseId: "t1", content: "boom", isError: true }]) as AgentEvent;
  const json = eventJson({ id: 8, event }) as { content: unknown[] };
  assert.deepEqual(json.content, [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }]);
});

test("a turn can be over only once its prompt is in the log", () => {
  const entries = [
    { id: 100, event: message("u1", "user", [text("first")]) as AgentEvent },
    { id: 200, event: message("a1", "assistant", [text("done")]) as AgentEvent },
    { id: 300, event: message("r1", "user", [{ type: "tool_result", toolUseId: "t", content: "x" }]) as AgentEvent },
    { id: 400, event: message("s1", "user", [text("[Request interrupted by user]")]) as AgentEvent },
  ];
  // A session's first prompt not logged yet: nothing to call over.
  assert.equal(promptSince([], null), false);
  assert.equal(promptSince(entries, null), true);
  // After a send: only a prompt past where the log stood counts, not a tool
  // result or the record of a stop.
  assert.equal(promptSince(entries, 200), false);
  assert.equal(promptSince([...entries, { id: 500, event: message("u2", "user", [text("again")]) as AgentEvent }], 200), true);
});

test("a send's fence is where the log stood before its message", () => {
  const sentAt = Date.parse("2026-11-01T00:00:00Z");
  const at = (ms: number) => ({ timestamp: new Date(sentAt + ms).toISOString() });
  const entries = [
    { id: 100, event: message("u1", "user", [text("fix it")], at(-60_000)) as AgentEvent },
    { id: 200, event: message("a1", "assistant", [text("done")], at(-50_000)) as AgentEvent },
    { id: 300, event: message("u2", "user", [text("fix it")], at(3_000)) as AgentEvent },
  ];
  // The newest prompt that reads as the message, logged after the send.
  assert.equal(fenceBefore(entries, " fix it ", sentAt), 200);
  assert.equal(promptSince(entries, fenceBefore(entries, "fix it", sentAt)), true);
  assert.equal(promptSince(entries.slice(0, 2), 200), false);
  // Its first prompt, logged a second early by the box's clock: still it.
  assert.equal(fenceBefore([{ id: 9, event: message("u0", "user", [text("go")], at(-1_000)) as AgentEvent }], "go", sentAt), 0);
  // Not in the log yet: no fence to give.
  assert.equal(fenceBefore(entries, "something else", sentAt), null);
});

test("a message sent with files is found by its words", () => {
  const sentAt = Date.parse("2026-11-01T00:00:00Z");
  const logged = promptWithAttachments("look at this", ["shot.png", "log.txt"]);
  const entries = [
    { id: 100, event: message("a0", "assistant", [text("hi")]) as AgentEvent },
    { id: 200, event: message("u1", "user", [text(logged)]) as AgentEvent },
  ];
  assert.equal(fenceBefore(entries, "look at this", sentAt), 100);
});

test("the same words sent again aren't taken for the last send's", () => {
  const sentAt = Date.parse("2026-11-01T00:00:00Z");
  // "continue" in a loop: the log has the last one, not yet this one.
  const entries = [
    { id: 100, event: message("u1", "user", [text("continue")], { timestamp: "2026-10-31T23:59:30Z" }) as AgentEvent },
    { id: 200, event: message("a1", "assistant", [text("ok")], { timestamp: "2026-10-31T23:59:40Z" }) as AgentEvent },
  ];
  assert.equal(fenceBefore(entries, "continue", sentAt), null);
});

test("a wait ends on its own turn, a question it answers isn't one", () => {
  const ask = (id: number, toolId: string) => ({
    id,
    event: message(`a${id}`, "assistant", [
      { type: "tool_use", id: toolId, name: "mcp__outrunner__ask_user", input: { questions: [{ question: "Which DB?", options: ["Postgres"] }] } },
    ]) as AgentEvent,
  });
  const prompt = (id: number, words: string) => ({ id, event: message(`u${id}`, "user", [text(words)]) as AgentEvent });
  const reply = (id: number) => ({ id, event: message(`r${id}`, "assistant", [text("Done.")], { stopReason: "end_turn" }) as AgentEvent });
  const asked = [prompt(100, "set it up"), ask(200, "q1")];
  // Answering it from a fence at the question: the answer isn't logged yet.
  assert.equal(turnSettled(asked, "running", { fenced: true, afterEvent: 200 }), false);
  // Without a fence, the question is the answer (wait was asked as is).
  assert.equal(turnSettled(asked, "running", { fenced: false, afterEvent: null }), true);
  // The answer is logged and worked on: still not over.
  assert.equal(turnSettled([...asked, prompt(300, "Postgres")], "running", { fenced: true, afterEvent: 200 }), false);
  // Its reply: over.
  assert.equal(turnSettled([...asked, prompt(300, "Postgres"), reply(400)], "running", { fenced: true, afterEvent: 200 }), true);
  // A new question after the answer: that one's for the caller.
  assert.equal(turnSettled([...asked, prompt(300, "Postgres"), ask(400, "q2")], "running", { fenced: true, afterEvent: 200 }), true);
  // A session the API started, before its first prompt: not over.
  assert.equal(turnSettled([], "running", { fenced: true, afterEvent: null }), false);
});

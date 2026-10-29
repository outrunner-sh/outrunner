import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentEvent,
  ConversationMessage,
  WorkspaceStateChanged,
} from "@/lib/runtime/agent-protocol";
import { appendEvent, isErrorReply, replyModel } from "@/lib/runtime/conversation-events";

const state = (s: WorkspaceStateChanged["state"]): AgentEvent => ({
  t: "state",
  workspaceId: "w",
  state: s,
});

const message = (uuid: string, text: string): ConversationMessage => ({
  t: "message",
  uuid,
  parentUuid: null,
  role: "assistant",
  timestamp: "t",
  content: [{ type: "text", text }],
});

test("appendEvent dedupes message frames by id", () => {
  const seen = new Set<string>();
  let events: AgentEvent[] = [];
  events = appendEvent(events, message("m1", "hi"), "42", seen);
  events = appendEvent(events, message("m1", "hi"), "42", seen); // dup
  events = appendEvent(events, message("m2", "yo"), "58", seen);
  assert.equal(events.length, 2);
  assert.equal((events[0] as ConversationMessage).uuid, "m1");
  assert.equal((events[1] as ConversationMessage).uuid, "m2");
});

test("appendEvent upserts a streaming message by uuid (new id each partial)", () => {
  const seen = new Set<string>();
  let events: AgentEvent[] = [];
  // Same turn streamed: same uuid, growing text, a fresh SSE id each time.
  events = appendEvent(events, message("m1", "p"), "10", seen);
  events = appendEvent(events, message("m1", "pon"), "20", seen);
  events = appendEvent(events, message("m1", "pong"), "30", seen);
  assert.equal(events.length, 1, "partials collapse to one message");
  const block = (events[0] as ConversationMessage).content[0];
  assert.ok(block.type === "text" && block.text === "pong", "shows the latest content");
  // A different turn appends after, preserving order.
  events = appendEvent(events, message("m2", "next"), "40", seen);
  assert.equal(events.length, 2);
  assert.equal((events[1] as ConversationMessage).uuid, "m2");
});

test("appendEvent collapses state — only one lives at a time", () => {
  const seen = new Set<string>();
  let events: AgentEvent[] = [];
  events = appendEvent(events, state("starting"), "0", seen);
  events = appendEvent(events, message("m1", "hi"), "42", seen);
  events = appendEvent(events, state("running"), "0", seen); // supersedes
  const states = events.filter((e) => e.t === "state") as WorkspaceStateChanged[];
  assert.equal(states.length, 1, "at most one state entry");
  assert.equal(states[0].state, "running");
  // Message survives across state replacements.
  const messages = events.filter((e) => e.t === "message");
  assert.equal(messages.length, 1);
});

test("appendEvent tolerates missing id", () => {
  const seen = new Set<string>();
  const events = appendEvent([], message("m1", "hi"), "", seen);
  assert.equal(events.length, 1);
});

test("appendEvent keeps a reconnect's running state where the last one was", () => {
  const seen = new Set<string>();
  let events: AgentEvent[] = [];
  events = appendEvent(events, state("running"), "0", seen);
  events = appendEvent(events, message("m1", "hi"), "10", seen);
  events = appendEvent(events, message("m2", "done"), "20", seen);
  // A reconnect re-emits running: no divider mid-conversation.
  events = appendEvent(events, state("running"), "0", seen);
  assert.deepEqual(events.map((e) => e.t), ["state", "message", "message"]);
  // Starting, then running at last: also where it was.
  let fresh: AgentEvent[] = appendEvent([], state("starting"), "0", seen);
  fresh = appendEvent(fresh, message("m3", "hello"), "30", seen);
  fresh = appendEvent(fresh, state("running"), "0", seen);
  assert.deepEqual(fresh.map((e) => (e.t === "state" ? e.state : e.t)), ["running", "message"]);
  // A real change shows where it happened.
  events = appendEvent(events, state("exited"), "0", seen);
  assert.deepEqual(events.map((e) => (e.t === "state" ? e.state : e.t)), ["message", "message", "exited"]);
  events = appendEvent(events, state("running"), "0", seen);
  assert.deepEqual(events.map((e) => (e.t === "state" ? e.state : e.t)), ["message", "message", "running"]);
});

test("a reply Claude Code wrote itself names no model, and an API error is one that failed", () => {
  const synthetic = { ...message("s1", "API Error: 400 bad request"), model: "<synthetic>" };
  assert.equal(replyModel(synthetic), undefined);
  assert.equal(isErrorReply(synthetic), true);
  assert.equal(isErrorReply({ ...synthetic, content: [{ type: "text", text: "No response requested." }] }), false);
  const real = { ...message("r1", "Done."), model: "claude-opus-5-5" };
  assert.equal(replyModel(real), "claude-opus-5-5");
  assert.equal(isErrorReply(real), false);
});

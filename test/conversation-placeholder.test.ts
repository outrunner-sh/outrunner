import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { conversationPlaceholder } from "@/lib/session/conversation-placeholder";

const said: AgentEvent = {
  t: "message",
  uuid: "m1",
  parentUuid: null,
  role: "user",
  timestamp: "t",
  content: [{ type: "text", text: "hi" }],
};
const state = (s: "running" | "exited" | "archived"): AgentEvent => ({ t: "state", workspaceId: "w", state: s });

test("an empty conversation is connecting until the session is attached", () => {
  assert.equal(conversationPlaceholder({ events: [], attachment: "idle", stream: "loading" }), "connecting");
  assert.equal(conversationPlaceholder({ events: [], attachment: "loading", stream: "loading" }), "connecting");
});

test("attached, it is connecting until the event stream is open", () => {
  assert.equal(conversationPlaceholder({ events: [], attachment: "attached", stream: "connecting" }), "connecting");
  assert.equal(conversationPlaceholder({ events: [], attachment: "attached", stream: "disconnected" }), "connecting");
});

test("connected with nothing said, it is ready", () => {
  assert.equal(conversationPlaceholder({ events: [], attachment: "attached", stream: "connected" }), "ready");
});

test("a failed connection says nothing: the error banner speaks", () => {
  assert.equal(conversationPlaceholder({ events: [], attachment: "error", stream: "loading" }), null);
  assert.equal(conversationPlaceholder({ events: [], attachment: "attached", stream: "error" }), null);
});

test("a conversation with anything said in it needs no placeholder", () => {
  assert.equal(conversationPlaceholder({ events: [said], attachment: "attached", stream: "connected" }), null);
  assert.equal(conversationPlaceholder({ events: [said], attachment: "loading", stream: "connecting" }), null);
});

test("the state the stream opens with is not something said: still connecting, then ready", () => {
  const running = [state("running")];
  assert.equal(conversationPlaceholder({ events: running, attachment: "attached", stream: "connecting" }), "connecting");
  assert.equal(conversationPlaceholder({ events: running, attachment: "attached", stream: "connected" }), "ready");
});

test("a session that has ended is not ready: its state row says so", () => {
  for (const ended of ["exited", "archived"] as const) {
    assert.equal(conversationPlaceholder({ events: [state(ended)], attachment: "attached", stream: "connected" }), null);
  }
});

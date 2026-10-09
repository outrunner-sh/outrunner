import assert from "node:assert/strict";
import { test } from "node:test";

import { conversationPlaceholder } from "@/lib/session/conversation-placeholder";

test("an empty conversation is connecting until the session is attached", () => {
  assert.equal(conversationPlaceholder({ events: 0, attachment: "idle", stream: "loading" }), "connecting");
  assert.equal(conversationPlaceholder({ events: 0, attachment: "loading", stream: "loading" }), "connecting");
});

test("attached, it is connecting until the event stream is open", () => {
  assert.equal(conversationPlaceholder({ events: 0, attachment: "attached", stream: "connecting" }), "connecting");
  assert.equal(conversationPlaceholder({ events: 0, attachment: "attached", stream: "disconnected" }), "connecting");
});

test("connected with nothing said, it is ready", () => {
  assert.equal(conversationPlaceholder({ events: 0, attachment: "attached", stream: "connected" }), "ready");
});

test("a failed connection says nothing: the error banner speaks", () => {
  assert.equal(conversationPlaceholder({ events: 0, attachment: "error", stream: "loading" }), null);
  assert.equal(conversationPlaceholder({ events: 0, attachment: "attached", stream: "error" }), null);
});

test("a conversation with anything in it needs no placeholder", () => {
  assert.equal(conversationPlaceholder({ events: 3, attachment: "attached", stream: "connected" }), null);
  assert.equal(conversationPlaceholder({ events: 1, attachment: "loading", stream: "connecting" }), null);
});

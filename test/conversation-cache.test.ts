import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ConversationMessage } from "@/lib/runtime/agent-protocol";
import { messageText } from "@/lib/runtime/conversation-events";
import { ConversationCache } from "@/lib/session/conversation-cache";

const message = (uuid: string, text: string): ConversationMessage => ({
  t: "message",
  uuid,
  parentUuid: null,
  role: "assistant",
  timestamp: "t",
  content: [{ type: "text", text }],
});
const state: AgentEvent = { t: "state", workspaceId: "w", state: "running" };
const entry = (n: number) => ({ events: [message(`m${n}`, "x")], lastEventId: String(n), seenIds: new Set<string>() });

test("a conversation kept is the one handed back", () => {
  const cache = new ConversationCache();
  const kept = entry(1);
  cache.set("w1", kept);
  assert.equal(cache.get("w1"), kept);
  assert.equal(cache.get("w2"), undefined);
});

test("past the limit the least recently opened goes, and opening one keeps it", () => {
  const cache = new ConversationCache(2);
  cache.set("w1", entry(1));
  cache.set("w2", entry(2));
  cache.get("w1"); // opened again: now the most recent
  cache.set("w3", entry(3));
  assert.ok(cache.get("w1"));
  assert.equal(cache.get("w2"), undefined);
  assert.ok(cache.get("w3"));
});

test("streamed events go in as the session's own stream takes them, cursor and all", () => {
  const cache = new ConversationCache();
  cache.append("w1", message("m1", "hel"), "10");
  cache.append("w1", message("m1", "hello"), "20"); // the same turn, grown
  cache.append("w1", state, "0"); // state: not resumable, no cursor
  const kept = cache.get("w1")!;
  assert.equal(kept.events.length, 2);
  assert.equal(messageText(kept.events[0]), "hello");
  assert.equal(kept.lastEventId, "20");
});

test("an event already taken in isn't taken twice", () => {
  const cache = new ConversationCache();
  const usage: AgentEvent = { t: "usage", inputTokens: 1, outputTokens: 2 } as unknown as AgentEvent;
  cache.append("w1", usage, "30");
  cache.append("w1", usage, "30");
  assert.equal(cache.get("w1")!.events.length, 1);
});

test("a deleted session's conversation is forgotten", () => {
  const cache = new ConversationCache();
  cache.set("w1", entry(1));
  cache.forget("w1");
  assert.equal(cache.get("w1"), undefined);
});

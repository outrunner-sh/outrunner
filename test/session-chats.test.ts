import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { conversationNodes } from "@/lib/runtime/conversation-nodes";
import {
  chatName,
  chatRoute,
  chatStateKey,
  defaultChatName,
  MAIN_CHAT,
  mainChatOf,
  orderedChats,
  parseChatId,
  type SessionChat,
  withoutCarried,
} from "@/lib/session/chats";
import { composerCommand } from "@/lib/session/session-mode";

const CHAT = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";

test("a chat is named by its id, or none for the main one", () => {
  assert.equal(parseChatId(undefined), MAIN_CHAT);
  assert.equal(parseChatId(""), MAIN_CHAT);
  assert.equal(parseChatId("main"), MAIN_CHAT);
  assert.equal(parseChatId(CHAT.toUpperCase()), CHAT);
  assert.equal(parseChatId("../etc"), null);
  assert.equal(parseChatId("c1"), null, "only the control plane's ids");
  assert.equal(parseChatId(42), null);
});

test("a chat's routes are the session's, its id added unless it's the main one", () => {
  assert.equal(chatRoute("ws", MAIN_CHAT, "message"), "/api/workspaces/ws/message");
  assert.equal(chatRoute("ws", CHAT, "message"), `/api/workspaces/ws/message?chat=${CHAT}`);
  assert.equal(chatRoute("ws", CHAT, "session?fresh=1"), `/api/workspaces/ws/session?fresh=1&chat=${CHAT}`);
  // What a tab kept before chats stays the main chat's.
  assert.equal(chatStateKey("ws", MAIN_CHAT), "ws");
  assert.equal(chatStateKey("ws", CHAT), `ws:${CHAT}`);
});

test("a new chat's name says what it is until it's renamed", () => {
  assert.equal(defaultChatName([]), "Chat 1");
  assert.equal(defaultChatName([{ name: "Chat 2" }]), "Chat 3");
  assert.equal(defaultChatName([{ name: "Chat 2" }, { name: "x" }]), "Chat 3");
  assert.equal(defaultChatName([{ name: "Chat 2" }, { name: "Chat 3" }]), "Chat 4");
  assert.equal(defaultChatName([], { from: { name: "Main" } }), "Fork of Main");
  assert.equal(defaultChatName([], { side: true, question: "  why\nthis? " }), "Side: why this?");
  assert.ok(defaultChatName([], { side: true, question: "x".repeat(200) }).length <= 80);
  assert.equal(chatName("  a   b "), "a b");
  assert.equal(chatName(""), null);
  assert.equal(chatName("x".repeat(81)), null);
});

test("the main chat is the session's, listed first", () => {
  const main = mainChatOf({ agent: "claude", model: null, createdAt: "2026-10-29T10:00:00Z" });
  assert.equal(main.name, "Main");
  assert.equal(mainChatOf({ agent: "codex", model: null, mainChatName: "Plan", createdAt: "t" }).name, "Plan");
  const chat = (id: string, createdAt: string): SessionChat => ({ id, name: id, agent: "claude", kind: "chat", forkedFrom: null, model: null, createdAt });
  assert.deepEqual(
    orderedChats(main, [chat("b", "2026-10-29T12:00:00Z"), chat("a", "2026-10-29T11:00:00Z")]).map((c) => c.id),
    [MAIN_CHAT, "a", "b"],
  );
});

test("/btw and /side ask in a side chat", () => {
  assert.deepEqual(composerCommand("/btw why is the test slow?"), { kind: "side", question: "why is the test slow?" });
  assert.deepEqual(composerCommand("/side\nwhat about docs"), { kind: "side", question: "what about docs" });
  assert.deepEqual(composerCommand("/btw"), { kind: "side", question: "" });
  assert.equal(composerCommand("/btwx hi"), null);
});

test("what a chat's prompt was sent with is folded out of its words", () => {
  const handoff = "<outrunner-handoff>\nThis chat continues from Main…\n</outrunner-handoff>\n\nNow add a test";
  assert.deepEqual(withoutCarried(handoff), { text: "Now add a test", carried: ["handoff"] });
  const side = "<outrunner-side-chat>\nnewest turns\n</outrunner-side-chat>\n\nwhy?";
  assert.deepEqual(withoutCarried(side), { text: "why?", carried: ["side"] });
  assert.deepEqual(withoutCarried("plain"), { text: "plain", carried: [] });

  const events: AgentEvent[] = [
    { t: "message", uuid: "u1", parentUuid: null, role: "user", timestamp: "2026-10-29T10:00:00Z", content: [{ type: "text", text: handoff }] },
  ];
  const [prompt] = conversationNodes(events);
  assert.equal(prompt.kind, "prompt");
  assert.equal(prompt.kind === "prompt" && prompt.text, "Now add a test");
  assert.deepEqual(prompt.kind === "prompt" && prompt.carried, ["handoff"]);
});

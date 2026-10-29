import assert from "node:assert/strict";
import { test } from "node:test";

import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import { archiveChat, chatUploadPaths, restoreChats } from "@/lib/session/chat-snapshots";
import type { SessionChat } from "@/lib/session/chats";

const PREFIX = "archives/owner/ws/2026-10-29T13-00-00Z/";
const chat = (id: string, agent: "claude" | "codex", over: Partial<SessionChat> = {}): SessionChat => ({
  id,
  name: id,
  agent,
  kind: "chat",
  forkedFrom: null,
  model: null,
  createdAt: "2026-10-29T10:00:00Z",
  ...over,
});

test("an archive puts each chat's conversation under its id, and a Codex chat's rollout", () => {
  assert.deepEqual(chatUploadPaths(PREFIX, chat("a1", "claude")), { conversation: `${PREFIX}chats/a1/conversation.jsonl` });
  assert.deepEqual(chatUploadPaths(PREFIX, chat("b2", "codex")), {
    conversation: `${PREFIX}chats/b2/conversation.jsonl`,
    rollout: `${PREFIX}chats/b2/rollout.jsonl`,
  });
  const docs = chat("a1", "claude", {
    name: "Docs",
    kind: "side",
    forkedFrom: "main",
    model: { model: { id: "opus", label: "Opus", provider: "claude" }, effort: "high" },
  });
  assert.deepEqual(archiveChat(docs, { conversation: "https://s/c" }), {
    chatId: "a1",
    name: "Docs",
    kind: "side",
    forkedFrom: "main",
    agent: "claude",
    model: { provider: "claude", id: "opus", effort: "high" },
    conversation: "https://s/c",
  });
});

test("a restore brings back each chat the Snapshot holds that the session still has", async () => {
  const manifest = {
    chats: [
      { id: "a1", name: "Docs", kind: "chat", forkedFrom: null, agent: "claude", model: null, sessionId: "s1", conversation: "chats/a1/conversation.jsonl" },
      {
        id: "b2",
        name: "Review",
        kind: "chat",
        forkedFrom: "main",
        agent: "codex",
        model: null,
        sessionId: "s2",
        conversation: "chats/b2/conversation.jsonl",
        rollout: "chats/b2/rollout.jsonl",
      },
      { id: "c3", name: "Deleted since", kind: "chat", forkedFrom: null, agent: "claude", model: null, sessionId: null, conversation: "chats/c3/conversation.jsonl" },
    ],
  } as unknown as SnapshotManifest;
  const restored = await restoreChats(manifest, [chat("a1", "claude"), chat("b2", "codex")], async (file) => `signed:${file}`);
  assert.deepEqual(restored, [
    { chatId: "a1", agent: "claude", sessionId: "s1", conversation: "signed:chats/a1/conversation.jsonl" },
    { chatId: "b2", agent: "codex", sessionId: "s2", conversation: "signed:chats/b2/conversation.jsonl", rollout: "signed:chats/b2/rollout.jsonl" },
  ]);
  // A Snapshot from before Snapshots kept every chat has none to bring back.
  assert.deepEqual(await restoreChats({} as SnapshotManifest, [chat("a1", "claude")], async (f) => f), []);
});

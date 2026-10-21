import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ConversationMessage } from "@/lib/runtime/agent-protocol";
import { messageText } from "@/lib/runtime/conversation-events";
import { ConversationCache, type CachedConversation } from "@/lib/session/conversation-cache";
import { KEPT_CHARS, KEPT_SESSIONS, KeptConversations } from "@/lib/session/kept-conversations";

const message = (uuid: string, text = "x"): ConversationMessage => ({
  t: "message",
  uuid,
  parentUuid: null,
  role: "assistant",
  timestamp: "t",
  content: [{ type: "text", text }],
});
const state: AgentEvent = { t: "state", workspaceId: "w", state: "running" };
const entry = (events: AgentEvent[], seen: string[] = []): CachedConversation => ({
  events,
  lastEventId: "99",
  seenIds: new Set(seen),
});

/** localStorage, with a quota in characters when given one. */
class FakeStorage {
  readonly items = new Map<string, string>();
  private readonly quota: number;
  constructor(quota = Infinity) {
    this.quota = quota;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    let used = value.length;
    for (const [k, v] of this.items) if (k !== key) used += v.length;
    if (used > this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

function kept(storage: FakeStorage) {
  const flushes: (() => void)[] = [];
  const store = new KeptConversations(() => storage, (flush) => flushes.push(flush));
  return { store, flushes };
}

test("a conversation outlives the page, without its state or a cursor to resume from", () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("w1", entry([message("m1", "hello"), state], ["30"]));
  store.flush();

  // A reload: a new page, the same storage.
  const cache = new ConversationCache(20, kept(storage).store);
  const back = cache.get("w1")!;
  assert.deepEqual(back.events, [message("m1", "hello")]);
  assert.deepEqual([...back.seenIds], ["30"]);
  assert.equal(back.lastEventId, null); // its stream replays from the start…
  cache.append("w1", message("m1", "hello"), "40"); // …which doesn't double it
  assert.equal(cache.get("w1")!.events.length, 1);
});

test("saves while a reply streams are written together, once", () => {
  const storage = new FakeStorage();
  const { store, flushes } = kept(storage);
  store.save("w1", entry([message("m1", "he")]));
  store.save("w1", entry([message("m1", "hello")]));
  assert.equal(flushes.length, 1);
  assert.equal(store.load("w1"), undefined); // not until the flush
  flushes[0]();
  assert.equal(messageText(store.load("w1")!.events[0]), "hello");
});

test("one too long to keep, or with nothing said, isn't kept, and no older copy stands in", () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("w1", entry([message("m1")]));
  store.save("w2", entry([message("m2")]));
  store.flush();
  store.save("w1", entry([message("m1", "x".repeat(KEPT_CHARS))]));
  store.save("w2", entry([state]));
  store.flush();
  assert.equal(store.load("w1"), undefined);
  assert.equal(store.load("w2"), undefined);
});

test("past the limit the least recently opened goes, and opening one keeps it", () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  for (let i = 0; i < KEPT_SESSIONS; i++) store.save(`w${i}`, entry([message(`m${i}`)]));
  store.flush();
  store.load("w0"); // opened again: now the most recent
  store.save("new", entry([message("n")]));
  store.flush();
  assert.ok(store.load("w0"));
  assert.equal(store.load("w1"), undefined);
  assert.ok(store.load("new"));
});

test("out of room, the least recently opened make way", () => {
  const one = JSON.stringify({ v: 1, events: [message("m0")], seenIds: [] }).length;
  const storage = new FakeStorage(one * 2 + 40); // two, and the index
  const { store } = kept(storage);
  for (const id of ["w0", "w1", "w2"]) {
    store.save(id, entry([message("m0")]));
    store.flush();
  }
  assert.equal(store.load("w0"), undefined);
  assert.ok(store.load("w1"));
  assert.ok(store.load("w2"));
});

test("one kept by an older build, or damaged, opens from the stream", () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  storage.setItem("outrunner:conversation:w1", JSON.stringify({ v: 0, events: [] }));
  storage.setItem("outrunner:conversation:w2", "{not json");
  storage.setItem("outrunner:conversation:w3", JSON.stringify({ v: 1, events: [{ t: "nope" }], seenIds: [] }));
  for (const id of ["w1", "w2", "w3"]) assert.equal(store.load(id), undefined);
  assert.equal(storage.getItem("outrunner:conversation:w1"), null);
});

test("deleting a session forgets its conversation, and signing out forgets them all", () => {
  const storage = new FakeStorage();
  const cache = new ConversationCache(20, kept(storage).store);
  const { store } = kept(storage);
  store.save("w1", entry([message("m1")]));
  store.save("w2", entry([message("m2")]));
  store.flush();
  cache.forget("w1");
  assert.equal(store.load("w1"), undefined);
  assert.ok(store.load("w2"));
  cache.clear();
  assert.equal(storage.items.size, 0);
});

test("blocked storage keeps nothing and breaks nothing", () => {
  const store = new KeptConversations(() => null, (flush) => flush());
  store.save("w1", entry([message("m1")]));
  assert.equal(store.load("w1"), undefined);
  assert.equal(new ConversationCache(20, store).get("w1"), undefined);
});

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

/** IndexedDB, as kept strings, with a quota in characters when given one. */
class FakeStorage {
  readonly items = new Map<string, string>();
  private readonly quota: number;
  constructor(quota = Infinity) {
    this.quota = quota;
  }
  async get(key: string) {
    return this.items.get(key);
  }
  async set(key: string, value: string) {
    let used = value.length;
    for (const [k, v] of this.items) if (k !== key) used += v.length;
    if (used > this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  async delete(key: string) {
    this.items.delete(key);
  }
  async keys() {
    return [...this.items.keys()];
  }
}

/** localStorage, where an older build kept them. */
class FakeLocalStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
}

function kept(storage: FakeStorage) {
  const flushes: (() => void)[] = [];
  const store = new KeptConversations(() => storage, (flush) => flushes.push(flush));
  return { store, flushes };
}

test("a conversation outlives the page, without its state or a cursor to resume from", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("w1", entry([message("m1", "hello"), state], ["30"]));
  await store.flush();

  // A reload: a new page, the same storage.
  const cache = new ConversationCache(20, kept(storage).store);
  assert.equal(cache.get("w1"), undefined); // not seen by this page…
  const back = (await cache.restore("w1"))!; // …but kept from before it
  assert.deepEqual(back.events, [message("m1", "hello")]);
  assert.deepEqual([...back.seenIds], ["30"]);
  assert.equal(back.lastEventId, null); // its stream replays from the start…
  assert.equal(cache.get("w1"), back);
  cache.append("w1", message("m1", "hello"), "40"); // …which doesn't double it
  assert.equal(cache.get("w1")!.events.length, 1);
});

test("one a warm-up's stream brought in while the store was read is the one restored", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("w1", entry([message("m1", "old")]));
  await store.flush();
  const cache = new ConversationCache(20, kept(storage).store);
  const restoring = cache.restore("w1");
  cache.append("w1", message("m1", "new"), "10");
  assert.equal(messageText((await restoring)!.events[0]), "new");
});

test("saves while a reply streams are written together, once", async () => {
  const storage = new FakeStorage();
  const { store, flushes } = kept(storage);
  store.save("w1", entry([message("m1", "he")]));
  store.save("w1", entry([message("m1", "hello")]));
  assert.equal(flushes.length, 1);
  assert.equal(await store.load("w1"), undefined); // not until the flush
  flushes[0]();
  assert.equal(messageText((await store.load("w1"))!.events[0]), "hello");
});

test("a long session's conversation is kept", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  // Megabytes, as a long session's tool output runs to.
  store.save("w1", entry([message("m1", "x".repeat(2_000_000))]));
  await store.flush();
  assert.ok(await store.load("w1"));
});

test("one too long to keep, or with nothing said, isn't kept, and no older copy stands in", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("w1", entry([message("m1")]));
  store.save("w2", entry([message("m2")]));
  await store.flush();
  store.save("w1", entry([message("m1", "x".repeat(KEPT_CHARS))]));
  store.save("w2", entry([state]));
  await store.flush();
  assert.equal(await store.load("w1"), undefined);
  assert.equal(await store.load("w2"), undefined);
});

test("past the limit the least recently opened goes, and opening one keeps it", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  for (let i = 0; i < KEPT_SESSIONS; i++) store.save(`w${i}`, entry([message(`m${i}`)]));
  await store.flush();
  await store.load("w0"); // opened again: now the most recent
  store.save("new", entry([message("n")]));
  await store.flush();
  assert.ok(await store.load("w0"));
  assert.equal(await store.load("w1"), undefined);
  assert.ok(await store.load("new"));
});

test("out of room, the least recently opened make way", async () => {
  const one = JSON.stringify({ v: 1, events: [message("m0")], seenIds: [] }).length;
  const storage = new FakeStorage(one * 2 + 40); // two, and the index
  const { store } = kept(storage);
  for (const id of ["w0", "w1", "w2"]) {
    store.save(id, entry([message("m0")]));
    await store.flush();
  }
  assert.equal(await store.load("w0"), undefined);
  assert.ok(await store.load("w1"));
  assert.ok(await store.load("w2"));
});

test("one kept by an older build, or damaged, opens from the stream", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  await storage.set("outrunner:conversation:w1", JSON.stringify({ v: 0, events: [] }));
  await storage.set("outrunner:conversation:w2", "{not json");
  await storage.set("outrunner:conversation:w3", JSON.stringify({ v: 1, events: [{ t: "nope" }], seenIds: [] }));
  for (const id of ["w1", "w2", "w3"]) assert.equal(await store.load(id), undefined);
  assert.equal(await storage.get("outrunner:conversation:w1"), undefined);
});

test("what an older build kept in localStorage is taken in, and leaves it", async () => {
  const legacy = new FakeLocalStorage();
  legacy.setItem("outrunner:conversation:w1", JSON.stringify({ v: 1, events: [message("m1", "one")], seenIds: ["5"] }));
  legacy.setItem("outrunner:conversation:w2", JSON.stringify({ v: 1, events: [message("m2", "two")], seenIds: [] }));
  legacy.setItem("outrunner:conversations", JSON.stringify(["w2", "w1"]));
  legacy.setItem("outrunner:drafts", "theirs");
  const storage = new FakeStorage();
  const { store } = kept(storage);
  await store.adopt(legacy);
  assert.deepEqual([...legacy.items.keys()], ["outrunner:drafts"]);
  assert.equal(messageText((await store.load("w1"))!.events[0]), "one");
  assert.deepEqual([...(await store.load("w1"))!.seenIds], ["5"]);
  assert.ok(await store.load("w2"));
});

test("one kept since in IndexedDB is newer than localStorage's copy, and the limit holds", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("w0", entry([message("m0", "newer")]));
  for (let i = 1; i < KEPT_SESSIONS; i++) store.save(`w${i}`, entry([message(`m${i}`)]));
  await store.flush();
  const legacy = new FakeLocalStorage();
  legacy.setItem("outrunner:conversation:w0", JSON.stringify({ v: 1, events: [message("m0", "older")], seenIds: [] }));
  legacy.setItem("outrunner:conversation:a", JSON.stringify({ v: 1, events: [message("a")], seenIds: [] }));
  legacy.setItem("outrunner:conversation:b", JSON.stringify({ v: 1, events: [message("b")], seenIds: [] }));
  legacy.setItem("outrunner:conversations", JSON.stringify(["a", "b", "w0"]));
  await store.adopt(legacy);
  assert.equal(messageText((await store.load("w0"))!.events[0]), "newer");
  // Full already: what localStorage kept is older than all of it.
  assert.equal(await store.load("a"), undefined);
  assert.equal(await store.load("b"), undefined);
  assert.equal(legacy.items.size, 0);
});

test("deleting a session forgets its conversation, and signing out forgets them all", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  const cache = new ConversationCache(20, store);
  store.save("w1", entry([message("m1")]));
  store.save("w2", entry([message("m2")]));
  await store.flush();
  cache.forget("w1");
  assert.equal(await store.load("w1"), undefined);
  assert.ok(await store.load("w2"));
  cache.clear();
  await store.flush(); // after the clear
  assert.equal(storage.items.size, 0);
});

test("a frame that lands during the sign-out round trip isn't kept", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  const cache = new ConversationCache(20, store);
  cache.append("w1", message("m1"), "10");
  await store.flush();

  cache.clear(); // the user clicked Log out
  cache.append("w1", message("m2"), "11"); // a frame still on its way
  await store.flush(); // …and the page goes

  assert.equal(storage.items.size, 0);
  assert.equal(await store.load("w1"), undefined);
});

test("one with no room even on its own leaves no older copy behind", async () => {
  const small = JSON.stringify({ v: 1, events: [message("m1")], seenIds: [] }).length;
  const storage = new FakeStorage(small + 40);
  const { store } = kept(storage);
  store.save("w1", entry([message("m1")]));
  await store.flush();
  store.save("w1", entry([message("m1", "x".repeat(small * 5))]));
  await store.flush();
  assert.equal(await store.load("w1"), undefined);
});

test("signing out forgets one the index lost", async () => {
  const storage = new FakeStorage();
  await storage.set("outrunner:conversation:orphan", JSON.stringify({ v: 1, events: [message("m1")], seenIds: [] }));
  const { store } = kept(storage);
  await store.clear();
  assert.equal(storage.items.size, 0);
});

test("blocked storage keeps nothing and breaks nothing", async () => {
  const store = new KeptConversations(() => null, (flush) => flush());
  store.save("w1", entry([message("m1")]));
  assert.equal(await store.load("w1"), undefined);
  assert.equal(await new ConversationCache(20, store).restore("w1"), undefined);
});

test("storage that fails keeps nothing and breaks nothing", async () => {
  const failing = {
    get: () => Promise.reject(new Error("gone")),
    set: () => Promise.reject(new Error("gone")),
    delete: () => Promise.reject(new Error("gone")),
    keys: () => Promise.reject(new Error("gone")),
  };
  const store = new KeptConversations(() => failing, () => {});
  store.save("w1", entry([message("m1")]));
  await store.flush();
  assert.equal(await store.load("w1"), undefined);
  await store.clear();
});

test("which sessions a conversation is held for: this page's, or one kept from before it", async () => {
  const storage = new FakeStorage();
  const { store } = kept(storage);
  store.save("kept", entry([message("m1")]));
  store.save("empty", entry([state]));
  await store.flush();
  const cache = new ConversationCache(20, kept(storage).store);
  cache.set("seen", entry([message("m2")]));
  assert.deepEqual(
    [...(await cache.held(["seen", "kept", "empty", "never"]))].sort(),
    ["kept", "seen"],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { askSideChat, startChatOnBox } from "@/lib/session/chat-actions";

test("a lost chat is recreated even when authentication discovers it first", async () => {
  const missing = new Error("missing chat");
  let exists = false;
  const calls: string[] = [];
  await startChatOnBox({
    ready: async () => { calls.push("ready"); if (!exists) throw missing; },
    start: async () => { calls.push("start"); },
    recreate: async () => { calls.push("recreate"); exists = true; },
    missing: (error) => error === missing,
  });
  assert.deepEqual(calls, ["ready", "recreate", "ready", "start"]);
});

test("a failed side question removes its empty chat without changing selection", async () => {
  for (const rejects of [false, true]) {
    const calls: string[] = [];
    const action = askSideChat({
      create: async () => "side",
      send: async () => { if (rejects) throw new Error("offline"); return false; },
      remove: async (chat) => { calls.push(`remove:${chat}`); },
      pick: () => { calls.push("pick"); },
    });
    if (rejects) await assert.rejects(action, /offline/);
    else assert.equal(await action, false);
    assert.deepEqual(calls, ["remove:side"]);
  }
});

test("an accepted side question selects its chat and keeps it", async () => {
  const calls: string[] = [];
  assert.equal(await askSideChat({
    create: async () => "side", send: async () => true,
    remove: async () => { calls.push("remove"); }, pick: (chat) => { calls.push(chat); },
  }), true);
  assert.deepEqual(calls, ["side"]);
});

test("a recreated fork uses its source and falls back only when the source is missing", async () => {
  const { createChatWithSourceFallback } = await import("@/lib/session/chat-actions");
  const missing = new Error("source missing");
  const calls: boolean[] = [];
  await createChatWithSourceFallback(async (source) => {
    calls.push(source);
    if (source) throw missing;
  }, true, (error) => error === missing);
  assert.deepEqual(calls, [true, false]);
  await assert.rejects(createChatWithSourceFallback(async () => { throw new Error("network"); }, true, () => false), /network/);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { moveApiKeyFromClaudeSlot, type ClaudeSlotStore } from "@/lib/providers/claude-slot";

/** The Claude slot and the Anthropic provider key, as the database keeps them,
 *  with the move as move_claude_slot_key does it: one step. Sealing here is
 *  reversible text, standing in for secret-box. */
function world(slot: string | null, provider: string | null = null) {
  const db = { slot, provider, hint: null as string | null };
  const store: ClaudeSlotStore = {
    readSlot: async () => db.slot,
    moveFromSlot: async (ciphertext, hint) => {
      if (db.slot !== ciphertext) return false;
      db.slot = null;
      if (db.provider === null) Object.assign(db, { provider: ciphertext, hint });
      return true;
    },
  };
  return { db, store };
}
const seal = (plain: string) => `sealed:${plain}`;
const open = (sealed: string) => {
  if (!sealed.startsWith("sealed:")) throw new Error("bad tag");
  return sealed.slice("sealed:".length);
};

const API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ";
const TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

test("an API key moves to the Anthropic provider, the same ciphertext, and leaves the slot", async () => {
  const { db, store } = world(seal(API_KEY));
  assert.equal(await moveApiKeyFromClaudeSlot(store, open), true);
  assert.deepEqual(db, { slot: null, provider: seal(API_KEY), hint: "WXYZ" });
  // Again: nothing more happens.
  assert.equal(await moveApiKeyFromClaudeSlot(store, open), false);
  assert.deepEqual(db, { slot: null, provider: seal(API_KEY), hint: "WXYZ" });
});

test("a subscription token, an empty slot, and a value that can't be opened all stay", async () => {
  for (const slot of [seal(TOKEN), null, "unreadable"]) {
    const { db, store } = world(slot);
    assert.equal(await moveApiKeyFromClaudeSlot(store, open), false);
    assert.deepEqual(db, { slot, provider: null, hint: null });
  }
});

test("an Anthropic key already saved with the provider is newer, and kept", async () => {
  const { db, store } = world(seal(API_KEY), seal("sk-ant-api03-newer-key-0123456789"));
  await moveApiKeyFromClaudeSlot(store, open);
  assert.equal(db.provider, seal("sk-ant-api03-newer-key-0123456789"));
  assert.equal(db.slot, null);
});

test("two requests that read the same key move it once, so a key removed in between stays removed", async () => {
  const { db, store } = world(seal(API_KEY));
  // A slow request reads the slot...
  const staleRead = await store.readSlot();
  // ...another moves the key, and the user removes it from Providers...
  assert.equal(await moveApiKeyFromClaudeSlot(store, open), true);
  db.provider = null;
  // ...then the slow one moves what it read: nothing, since the slot no longer holds it.
  const slow = { readSlot: async () => staleRead, moveFromSlot: store.moveFromSlot };
  assert.equal(await moveApiKeyFromClaudeSlot(slow, open), false);
  assert.equal(db.provider, null, "the removed key came back");
});

test("a slot changed since it was read is left as it now is", async () => {
  const { db, store } = world(seal(API_KEY));
  // The user connects a subscription token in between.
  const read = store.readSlot;
  store.readSlot = async () => {
    const value = await read();
    db.slot = seal(TOKEN);
    return value;
  };
  assert.equal(await moveApiKeyFromClaudeSlot(store, open), false);
  assert.equal(db.slot, seal(TOKEN));
  assert.equal(db.provider, null);
});

test("a failed move leaves the key in the slot", async () => {
  const { db, store } = world(seal(API_KEY));
  store.moveFromSlot = async () => {
    throw new Error("database down");
  };
  await assert.rejects(moveApiKeyFromClaudeSlot(store, open), /database down/);
  assert.equal(db.slot, seal(API_KEY));
});

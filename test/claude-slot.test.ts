import assert from "node:assert/strict";
import { test } from "node:test";

import { moveApiKeyFromClaudeSlot, type ClaudeSlotStore } from "@/lib/providers/claude-slot";

/** The Claude slot and the Anthropic provider key, as the database keeps them.
 *  Sealing here is reversible text, standing in for secret-box. */
function world(slot: string | null, provider: string | null = null) {
  const db = { slot, provider, hint: null as string | null };
  const store: ClaudeSlotStore = {
    readSlot: async () => db.slot,
    copyToProvider: async (ciphertext, hint) => {
      if (db.provider === null) Object.assign(db, { provider: ciphertext, hint });
    },
    clearSlotIf: async (ciphertext) => {
      if (db.slot === ciphertext) db.slot = null;
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
  // Again, or twice at once: nothing more happens.
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

test("a slot changed while the key moved is left as it now is", async () => {
  const { db, store } = world(seal(API_KEY));
  // The user connects a subscription token in between.
  const copy = store.copyToProvider;
  store.copyToProvider = async (ciphertext, hint) => {
    await copy(ciphertext, hint);
    db.slot = seal(TOKEN);
  };
  await moveApiKeyFromClaudeSlot(store, open);
  assert.equal(db.slot, seal(TOKEN));
  assert.equal(db.provider, seal(API_KEY));
});

test("a failed copy leaves the key in the slot", async () => {
  const { db, store } = world(seal(API_KEY));
  store.copyToProvider = async () => {
    throw new Error("database down");
  };
  await assert.rejects(moveApiKeyFromClaudeSlot(store, open), /database down/);
  assert.equal(db.slot, seal(API_KEY));
});

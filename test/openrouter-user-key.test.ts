import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureUserKey, StoredKeyUnreadableError, type UserKeyStore } from "@/lib/openrouter/user-key";

/** One user's row, with the claim's "only if none is stored yet". */
function memoryStore(initial: { ciphertext: string | null; hash: string | null } = { ciphertext: null, hash: null }) {
  const row = { ...initial };
  const store: UserKeyStore & { row: typeof row } = {
    row,
    async read() {
      return { ...row };
    },
    async claim(key) {
      if (row.ciphertext) return false;
      row.ciphertext = key.ciphertext;
      row.hash = key.hash;
      return true;
    },
  };
  return store;
}

function deps(overrides: Partial<Parameters<typeof ensureUserKey>[1]> = {}) {
  let n = 0;
  const created: string[] = [];
  const disabled: string[] = [];
  const logged: string[] = [];
  return {
    created,
    disabled,
    logged,
    deps: {
      open: (c: string) => c.replace(/^sealed:/, ""),
      seal: (k: string) => `sealed:${k}`,
      create: async () => {
        n++;
        created.push(`h${n}`);
        return { key: `sk-or-${n}`, hash: `h${n}` };
      },
      disable: async (hash: string) => {
        disabled.push(hash);
      },
      log: (message: string) => {
        logged.push(message);
      },
      ...overrides,
    },
  };
}

test("the first pick creates and stores a key; later picks reuse it", async () => {
  const store = memoryStore();
  const d = deps();
  assert.equal(await ensureUserKey(store, d.deps), "sk-or-1");
  assert.equal(store.row.ciphertext, "sealed:sk-or-1");
  assert.equal(await ensureUserKey(store, d.deps), "sk-or-1");
  assert.deepEqual(d.created, ["h1"], "a second key was created");
});

test("two first picks at once store one key, disable the other, and agree", async () => {
  const store = memoryStore();
  const d = deps();
  const [a, b] = await Promise.all([ensureUserKey(store, d.deps), ensureUserKey(store, d.deps)]);
  assert.equal(a, b);
  assert.equal(d.created.length, 2);
  assert.deepEqual(d.disabled, [d.created.find((h) => `sealed:sk-or-${h.slice(1)}` !== store.row.ciphertext)]);
});

test("a key that can't be sealed is disabled, not left live", async () => {
  const store = memoryStore();
  const d = deps({ seal: () => { throw new Error("no CREDENTIALS_ENCRYPTION_KEY"); } });
  await assert.rejects(ensureUserKey(store, d.deps), /CREDENTIALS_ENCRYPTION_KEY/);
  assert.deepEqual(d.disabled, ["h1"]);
  assert.equal(store.row.ciphertext, null);
});

test("a key that can't be stored is disabled, not left live", async () => {
  const store = memoryStore();
  store.claim = async () => { throw new Error("db down"); };
  const d = deps();
  await assert.rejects(ensureUserKey(store, d.deps), /db down/);
  assert.deepEqual(d.disabled, ["h1"]);
});

test("a stored key that can't be decrypted is reported, never replaced", async () => {
  const store = memoryStore({ ciphertext: "garbled", hash: "h-old" });
  const d = deps({ open: () => { throw new Error("bad tag"); } });
  await assert.rejects(ensureUserKey(store, d.deps), StoredKeyUnreadableError);
  assert.deepEqual(d.created, [], "a replacement would bring a fresh allowance");
  assert.deepEqual(d.disabled, []);
  assert.equal(store.row.hash, "h-old");
  assert.match(d.logged.join("\n"), /h-old/);
});

test("a failed disable is logged with the id to disable by hand", async () => {
  const store = memoryStore();
  const d = deps({
    seal: () => { throw new Error("seal failed"); },
    disable: async () => { throw new Error("openrouter down"); },
  });
  await assert.rejects(ensureUserKey(store, d.deps), /seal failed/);
  assert.match(d.logged.join("\n"), /h1.*by hand/);
});

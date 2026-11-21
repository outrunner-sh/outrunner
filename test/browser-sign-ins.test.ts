import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import {
  answerBoxCall,
  boxScope,
  keptUntil,
  MAX_STATE_BYTES,
  openSignIns,
  parseStorageState,
  RETENTION_DAYS,
  sealSignIns,
  signInSites,
  type SignInScope,
  type SignInStore,
  type StorageState,
  type StoredSignIns,
} from "@/lib/browser-sign-ins/sign-ins";
import { open, seal } from "@/lib/crypto/secret-box";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = savedKey;
});

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ALICE: SignInScope = { ownerId: "alice", projectId: "staging-app" };

const STATE: StorageState = {
  cookies: [
    { name: "sid", value: "s3cret", domain: "staging.example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "pref", value: "p", domain: ".example.com", path: "/", expires: 1_900_000_000, httpOnly: false, secure: true, sameSite: "None" },
  ],
  origins: [{ origin: "https://staging.example.com", localStorage: [{ name: "token", value: "t" }] }],
};

/** A store over one map, by owner and project. */
function memoryStore(keeps = true): SignInStore & { rows: Map<string, StoredSignIns>; touched: string[] } {
  const rows = new Map<string, StoredSignIns>();
  const touched: string[] = [];
  const key = (scope: SignInScope) => `${scope.ownerId}/${scope.projectId}`;
  return {
    rows,
    touched,
    keeps: async () => keeps,
    load: async (scope) => rows.get(key(scope)) ?? null,
    save: async (scope, stored) => void rows.set(key(scope), stored),
    touch: async (scope, expiresAt) => {
      touched.push(expiresAt);
      const row = rows.get(key(scope));
      if (row) rows.set(key(scope), { ...row, expiresAt });
    },
    remove: async (scope) => void rows.delete(key(scope)),
  };
}

const crypto = { seal, open };

test("a storageState is only the fields one has, and anything else isn't one", () => {
  const extra = { ...STATE, cookies: [{ ...STATE.cookies[0], partitionKey: "x" }], extra: true };
  assert.deepEqual(parseStorageState(extra), { cookies: [STATE.cookies[0]], origins: STATE.origins });
  assert.deepEqual(parseStorageState({}), { cookies: [], origins: [] });
  for (const bad of [
    null,
    [],
    { cookies: "sid=1" },
    { cookies: [{ ...STATE.cookies[0], sameSite: "lax" }] },
    { cookies: [{ ...STATE.cookies[0], expires: "never" }] },
    { cookies: [{ ...STATE.cookies[0], domain: "" }] },
    { origins: [{ origin: "https://staging.example.com/login", localStorage: [] }] },
    { origins: [{ origin: "file:///etc", localStorage: [] }] },
    { origins: [{ origin: "https://a.example", localStorage: [{ name: "k", value: 1 }] }] },
  ]) {
    assert.equal(parseStorageState(bad), null, JSON.stringify(bad));
  }
});

test("sign-ins are sealed with whose they are, and open only as theirs, while kept", () => {
  const stored = sealSignIns(ALICE, STATE, seal, NOW);
  assert.ok(!stored.stateCiphertext.includes("s3cret"), "the cookie's value is in the clear");
  assert.equal(stored.expiresAt, new Date(NOW + RETENTION_DAYS * 86_400_000).toISOString());
  assert.deepEqual(openSignIns(ALICE, stored, open, NOW), STATE);

  // A row moved to another person, or project, doesn't open as theirs.
  assert.equal(openSignIns({ ownerId: "bob", projectId: "staging-app" }, stored, open, NOW), null);
  assert.equal(openSignIns({ ownerId: "alice", projectId: "other" }, stored, open, NOW), null);
  // Nor once they're past their time, nor sealed under another key.
  assert.equal(openSignIns(ALICE, stored, open, Date.parse(stored.expiresAt)), null);
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.equal(openSignIns(ALICE, stored, open, NOW), null);
});

test("a box's sign-ins are its own session's owner's, in its project, and a shared box keeps none", () => {
  const computer = { id: "c1", ownerId: "alice", orgId: "org", workspaceId: "ws1" };
  const session = { id: "ws1", ownerId: "alice", orgId: "org", projectId: "staging-app" };
  assert.deepEqual(boxScope(computer, session), ALICE);
  // A project's shared box: every session's on it.
  assert.equal(boxScope({ ...computer, workspaceId: null }, session), null);
  // Not the session the box was made for, or not the box's owner's, or org's.
  assert.equal(boxScope(computer, { ...session, id: "ws2" }), null);
  assert.equal(boxScope(computer, { ...session, ownerId: "bob" }), null);
  assert.equal(boxScope(computer, { ...session, orgId: "other-org" }), null);
  assert.equal(boxScope(computer, null), null);
});

test("Settings lists the sites sign-ins are for, never a value", () => {
  assert.deepEqual(signInSites(STATE), ["example.com", "staging.example.com"]);
});

test("a box saves its session's sign-ins, and a new box loads them, kept longer for the use", async () => {
  const store = memoryStore();
  assert.deepEqual(await answerBoxCall(ALICE, { op: "load" }, store, crypto, NOW), { status: 200, body: { state: null } });
  assert.deepEqual(await answerBoxCall(ALICE, { op: "save", state: STATE }, store, crypto, NOW), { status: 200, body: { kept: true } });
  assert.equal(store.rows.size, 1);

  const later = NOW + 86_400_000;
  assert.deepEqual(await answerBoxCall(ALICE, { op: "load" }, store, crypto, later), { status: 200, body: { state: STATE } });
  assert.deepEqual(store.touched, [keptUntil(later)]);
  // Another person in the project gets none of them.
  assert.deepEqual(await answerBoxCall({ ownerId: "bob", projectId: "staging-app" }, { op: "load" }, store, crypto, later), {
    status: 200,
    body: { state: null },
  });
});

test("sign-ins past their time, or that don't open, are deleted when asked for", async () => {
  const store = memoryStore();
  await answerBoxCall(ALICE, { op: "save", state: STATE }, store, crypto, NOW);
  const expired = NOW + (RETENTION_DAYS + 1) * 86_400_000;
  assert.deepEqual(await answerBoxCall(ALICE, { op: "load" }, store, crypto, expired), { status: 200, body: { state: null } });
  assert.equal(store.rows.size, 0);
  assert.deepEqual(store.touched, []);
});

test("a person who doesn't keep their sign-ins has none loaded, and none saved", async () => {
  const store = memoryStore(false);
  store.rows.set("alice/staging-app", sealSignIns(ALICE, STATE, seal, NOW));
  assert.deepEqual(await answerBoxCall(ALICE, { op: "load" }, store, crypto, NOW), { status: 200, body: { state: null } });
  assert.deepEqual(await answerBoxCall(ALICE, { op: "save", state: { ...STATE, cookies: [] } }, store, crypto, NOW + 1), {
    status: 200,
    body: { kept: false },
  });
  assert.equal(store.rows.get("alice/staging-app")?.savedAt, new Date(NOW).toISOString());
});

test("an empty save deletes the sign-ins, and one that isn't sign-ins, or is too big, is refused", async () => {
  const store = memoryStore();
  await answerBoxCall(ALICE, { op: "save", state: STATE }, store, crypto, NOW);
  assert.deepEqual(await answerBoxCall(ALICE, { op: "save", state: { cookies: [], origins: [] } }, store, crypto, NOW), {
    status: 200,
    body: { kept: true },
  });
  assert.equal(store.rows.size, 0);

  assert.equal((await answerBoxCall(ALICE, { op: "save", state: { cookies: "x" } }, store, crypto, NOW)).status, 400);
  assert.equal((await answerBoxCall(ALICE, { op: "delete" }, store, crypto, NOW)).status, 400);
  const huge = { cookies: [], origins: [{ origin: "https://a.example", localStorage: [{ name: "k", value: "x".repeat(MAX_STATE_BYTES) }] }] };
  assert.equal((await answerBoxCall(ALICE, { op: "save", state: huge }, store, crypto, NOW)).status, 413);
  assert.equal(store.rows.size, 0);
});

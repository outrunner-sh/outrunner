import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import {
  accountWithToken,
  adoptSlot,
  answerLimit,
  checkLabel,
  ClaudeAccountError,
  MAX_CLAUDE_ACCOUNTS,
  removeAccount,
  removeAllAccounts,
  reorderAccounts,
  replaceFirstAccount,
  saveAccount,
  sessionAccount,
  settleSlot,
  slotAccount,
  switchFromLimited,
  limitUntil,
  view,
  type ClaudeAccount,
  type ClaudeAccountStore,
} from "@/lib/claude/accounts";
import { open } from "@/lib/crypto/secret-box";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = savedKey;
});

/** One person's accounts in memory, and what the Claude slot was last told. */
function memoryStore(initial: ClaudeAccount[] = []) {
  let rows = initial.map((row) => ({ ...row }));
  let clock = Date.parse("2026-11-21T10:00:00Z");
  const mirrored: (string | null)[] = [];
  const store: ClaudeAccountStore = {
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async insert(account) {
      if (rows.some((row) => row.label.toLowerCase() === account.label.toLowerCase())) throw new Error("duplicate label");
      rows.push({ ...account, id: randomUUID(), limitedUntil: null, needsReconnect: false, createdAt: new Date(clock++).toISOString() });
    },
    async update(id, patch) {
      rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    },
    async remove(id) {
      rows = rows.filter((row) => row.id !== id);
    },
    async mirror(first) {
      mirrored.push(first ? first.label : null);
    },
  };
  return { store, mirrored, rows: () => rows };
}

const token = (name: string) => `sk-ant-oat01-${name}-${"x".repeat(40)}`;

function account(label: string, position: number, extra: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return { id: randomUUID(), label, ciphertext: "v1.a.b.c", hint: "abcd", position, limitedUntil: null, needsReconnect: false, createdAt: `2026-11-0${position + 1}T00:00:00Z`, ...extra };
}

test("a label is trimmed, kept to 32 characters, and plain", () => {
  assert.deepEqual(checkLabel("  work   laptop "), { label: "work laptop" });
  assert.deepEqual(checkLabel("Max_2.personal-b"), { label: "Max_2.personal-b" });
  assert.ok("error" in checkLabel(""));
  assert.ok("error" in checkLabel("   "));
  assert.ok("error" in checkLabel(42));
  assert.ok("error" in checkLabel("x".repeat(33)));
  assert.ok("error" in checkLabel("-work"));
  assert.ok("error" in checkLabel("work<script>"));
});

test("a session starts on the first account in order that can run", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const work = account("work", 0, { limitedUntil: "2026-11-21T15:00:00Z" });
  const spare = account("spare", 2);
  const personal = account("personal", 1, { needsReconnect: true });
  assert.equal(sessionAccount([spare, personal, work], now)?.label, "spare");
  // Its limit past, the first is first again.
  assert.equal(sessionAccount([spare, personal, work], Date.parse("2026-11-21T15:00:00Z"))?.label, "work");
});

test("when no account can run, the session still starts on the first, and with none there is none", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const work = account("work", 0, { limitedUntil: "2026-11-21T15:00:00Z" });
  const personal = account("personal", 1, { limitedUntil: "2026-11-21T13:00:00Z" });
  assert.equal(sessionAccount([personal, work], now)?.label, "work");
  assert.equal(sessionAccount([], now), null);
});

test("saving adds accounts in order, seals the token, and the slot holds the first", async () => {
  const { store, mirrored, rows } = memoryStore();
  await saveAccount(store, "work", token("work"));
  const after = await saveAccount(store, "personal", token("personal"));
  assert.deepEqual(after.map((a) => [a.label, a.position]), [["work", 0], ["personal", 1]]);
  assert.equal(open(rows()[1].ciphertext), token("personal"));
  assert.ok(!rows()[1].ciphertext.includes("personal"));
  assert.equal(rows()[1].hint, token("personal").slice(-4));
  assert.deepEqual(mirrored, ["work", "work"]);
});

test("saving under a label already used, in any case, replaces that account's token and clears its limit", async () => {
  const work = account("Work", 0, { limitedUntil: "2026-11-21T15:00:00Z", needsReconnect: true });
  const { store, rows } = memoryStore([work]);
  const after = await saveAccount(store, "work", token("fresh"));
  assert.equal(after.length, 1);
  assert.equal(after[0].label, "Work");
  assert.equal(open(rows()[0].ciphertext), token("fresh"));
  assert.equal(rows()[0].limitedUntil, null);
  assert.equal(rows()[0].needsReconnect, false);
});

test(`an eleventh account is refused with a message, the ten kept`, async () => {
  const { store } = memoryStore(Array.from({ length: MAX_CLAUDE_ACCOUNTS }, (_, i) => account(`a${i}`, i)));
  await assert.rejects(
    saveAccount(store, "one more", token("x")),
    (error: unknown) => error instanceof ClaudeAccountError && error.status === 409 && /up to 10/.test(error.message),
  );
  assert.equal((await store.list()).length, MAX_CLAUDE_ACCOUNTS);
});

test("the single-token doors replace the first account's token, or connect one as default", async () => {
  const empty = memoryStore();
  const first = await replaceFirstAccount(empty.store, token("one"));
  assert.deepEqual(first.map((a) => a.label), ["default"]);

  const two = memoryStore([account("personal", 1), account("work", 0)]);
  const after = await replaceFirstAccount(two.store, token("new"));
  assert.deepEqual(after.map((a) => a.label), ["work", "personal"]);
  assert.equal(open(two.rows().find((a) => a.label === "work")!.ciphertext), token("new"));
});

test("removing an account moves the slot to the next, and an unknown id is a 404", async () => {
  const work = account("work", 0);
  const { store, mirrored } = memoryStore([work, account("personal", 1)]);
  const after = await removeAccount(store, work.id);
  assert.deepEqual(after.map((a) => a.label), ["personal"]);
  assert.deepEqual(mirrored, ["personal"]);
  await assert.rejects(removeAccount(store, randomUUID()), (error: unknown) => error instanceof ClaudeAccountError && error.status === 404);
});

test("disconnecting removes every account and empties the slot", async () => {
  const { store, mirrored } = memoryStore([account("work", 0), account("personal", 1)]);
  await removeAllAccounts(store);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(mirrored, [null]);
});

test("reordering takes every account once; the slot follows the new first", async () => {
  const work = account("work", 0);
  const personal = account("personal", 1);
  const spare = account("spare", 2);
  const { store, mirrored } = memoryStore([work, personal, spare]);
  const after = await reorderAccounts(store, [spare.id, work.id, personal.id]);
  assert.deepEqual(after.map((a) => [a.label, a.position]), [["spare", 0], ["work", 1], ["personal", 2]]);
  assert.deepEqual(mirrored, ["spare"]);
  for (const bad of [[work.id, personal.id], [work.id, work.id, personal.id], [work.id, personal.id, randomUUID()]]) {
    await assert.rejects(reorderAccounts(store, bad), (error: unknown) => error instanceof ClaudeAccountError && error.status === 409);
  }
});

test("a token in the Claude slot from before becomes the default account, once", async () => {
  const { store } = memoryStore();
  const slot = { ciphertext: "v1.slot.token.sealed", hint: "wxyz" };
  const adopted = await adoptSlot(store, slot);
  assert.deepEqual(adopted.map((a) => [a.label, a.ciphertext, a.hint, a.position]), [["default", slot.ciphertext, "wxyz", 0]]);
  assert.equal((await adoptSlot(store, slot)).length, 1);
  // Nothing in the slot, nothing adopted.
  assert.deepEqual(await adoptSlot(memoryStore().store, null), []);
});

test("what Settings sees has no token", () => {
  const seen = view(account("work", 0, { hint: "1234", ciphertext: "v1.secret.sealed.value" }));
  assert.equal(seen.last4, "1234");
  assert.ok(!JSON.stringify(seen).includes("secret"));
});

test("a limit lasts until the reset Claude Code reported, else an hour; a far-off reset isn't believed", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assert.equal(limitUntil("2026-11-21T15:00:00Z", now), "2026-11-21T15:00:00.000Z");
  assert.equal(limitUntil(null, now), "2026-11-21T13:00:00.000Z");
  assert.equal(limitUntil("not a time", now), "2026-11-21T13:00:00.000Z");
  assert.equal(limitUntil("2026-11-21T11:00:00Z", now), "2026-11-21T13:00:00.000Z");
  assert.equal(limitUntil("2026-12-30T00:00:00Z", now), "2026-11-21T13:00:00.000Z");
  // A weekly limit's reset is believed.
  assert.equal(limitUntil("2026-11-27T09:00:00Z", now), "2026-11-27T09:00:00.000Z");
});

test("the account holding a token is found by opening each, and a token no account holds is none", () => {
  const work = account("work", 0, { ciphertext: "sealed:work" });
  const personal = account("personal", 1, { ciphertext: "sealed:personal" });
  const broken = account("broken", 2, { ciphertext: "sealed:broken" });
  const openToken = (ciphertext: string) => {
    if (ciphertext === "sealed:broken") throw new Error("unreadable");
    return ciphertext.replace("sealed:", "token-");
  };
  assert.equal(accountWithToken([broken, work, personal], "token-personal", openToken)?.label, "personal");
  assert.equal(accountWithToken([work, personal], "token-other", openToken), null);
});

test("switching marks the limited account and carries on with the next that can run", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const work = account("work", 0);
  const personal = account("personal", 1, { needsReconnect: true });
  const spare = account("spare", 2);
  const { store, rows } = memoryStore([work, personal, spare]);
  const result = await switchFromLimited(store, work, "2026-11-21T15:00:00Z", now);
  assert.equal(result.next?.label, "spare");
  assert.equal(result.limitedUntil, "2026-11-21T15:00:00.000Z");
  assert.equal(result.firstReset, null);
  assert.equal(rows().find((a) => a.label === "work")!.limitedUntil, "2026-11-21T15:00:00.000Z");
  // A new session now starts on spare.
  assert.equal(sessionAccount(rows(), now)?.label, "spare");
});

test("with every account out, there's no next, and it says when the first resets", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const work = account("work", 0);
  const personal = account("personal", 1, { limitedUntil: "2026-11-21T14:00:00Z" });
  const { store } = memoryStore([work, personal]);
  const result = await switchFromLimited(store, work, "2026-11-21T15:00:00Z", now);
  assert.equal(result.next, null);
  assert.equal(result.firstReset, "2026-11-21T14:00:00.000Z");
});

test("a limit on a token that isn't one of the accounts marks nothing, and still names one to carry on with", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const { store, rows } = memoryStore([account("work", 0)]);
  const result = await switchFromLimited(store, null, null, now);
  assert.equal(result.limited, null);
  assert.equal(result.next?.label, "work");
  assert.equal(rows()[0].limitedUntil, null);
});

test("a box names its account by the token's SHA-256, and hears back the next account's token", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const { store, rows } = memoryStore();
  await saveAccount(store, "work", token("work"));
  await saveAccount(store, "personal", token("personal"));
  const sha = createHash("sha256").update(token("work")).digest("hex");

  const answer = await answerLimit(store, { tokenSha256: sha, resetsAt: "2026-11-21T15:00:00Z", now }, open);
  assert.deepEqual(answer, { token: token("personal"), label: "personal", from: "work" });
  assert.equal(rows().find((a) => a.label === "work")!.limitedUntil, "2026-11-21T15:00:00.000Z");

  // Then personal hits its limit too: nothing left, and when work resets.
  const personalSha = createHash("sha256").update(token("personal")).digest("hex");
  const out = await answerLimit(store, { tokenSha256: personalSha, resetsAt: null, now }, open);
  assert.deepEqual(out, { token: null, from: "personal", firstReset: "2026-11-21T13:00:00.000Z" });
});

test("an unknown token hash marks nothing", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const { store, rows } = memoryStore();
  await saveAccount(store, "work", token("work"));
  const answer = await answerLimit(store, { tokenSha256: "0".repeat(64), resetsAt: null, now }, open);
  assert.deepEqual(answer, { token: token("work"), label: "work", from: null });
  assert.equal(rows()[0].limitedUntil, null);
});

test("a session never starts on a token that won't open while one that will is there", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const stale = account("default", 0);
  const personal = account("personal", 1);
  const readable = (a: ClaudeAccount) => a.label !== "default";
  assert.equal(sessionAccount([stale, personal], now, readable)?.label, "personal");
  // Readable but at its limit still beats unreadable; with nothing readable, the first.
  const limited = account("personal", 1, { limitedUntil: "2026-11-21T15:00:00Z" });
  assert.equal(sessionAccount([stale, limited], now, readable)?.label, "personal");
  assert.equal(sessionAccount([stale], now, readable)?.label, "default");
});

test("the Claude slot holds the first account that works, and what Settings sees says which won't open", async () => {
  const stale = account("default", 0);
  const personal = account("personal", 1);
  const memory = memoryStore([stale, personal]);
  const store: ClaudeAccountStore = { ...memory.store, readable: (a) => a.label !== "default" };
  const after = await settleSlot(store);
  assert.deepEqual(after.map((a) => a.label), ["default", "personal"]);
  assert.deepEqual(memory.mirrored, ["personal"]);
  assert.equal(slotAccount([stale, personal], () => true)?.label, "default");
  assert.equal(slotAccount([account("x", 0, { needsReconnect: true }), personal])?.label, "personal");
  assert.equal(view(stale, false).unreadable, true);
  assert.equal(view(personal).unreadable, false);
});

test("switching at a limit skips an account whose token won't open", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const work = account("work", 0);
  const stale = account("stale", 1);
  const spare = account("spare", 2);
  const memory = memoryStore([work, stale, spare]);
  const store: ClaudeAccountStore = { ...memory.store, readable: (a) => a.label !== "stale" };
  const result = await switchFromLimited(store, work, null, now);
  assert.equal(result.next?.label, "spare");
});

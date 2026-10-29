import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { authMethodsFor } from "@/lib/agents/registry";
import { claudeTokenLanded, watchClaudeToken } from "@/lib/claude-connect";
import { connectClaudeCommand } from "@/lib/onboarding/rules";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";

const none: ClaudeTokenMeta = { connected: false, last4: null, updatedAt: null };
const saved = (updatedAt: string | null, last4 = "ab12"): ClaudeTokenMeta => ({ connected: true, last4, updatedAt });

test("from none, the first token the CLI saves is the one", () => {
  assert.equal(claudeTokenLanded(none, none), false);
  assert.equal(claudeTokenLanded(saved("2026-10-26T10:00:00Z"), none), true);
  // An older row with no save time still connects from none.
  assert.equal(claudeTokenLanded(saved(null), none), true);
});

test("on a reconnect, only a token saved since counts", () => {
  const before = saved("2026-10-26T10:00:00Z");
  // Still the old token: connected the whole time, so not done yet.
  assert.equal(claudeTokenLanded(before, before), false);
  assert.equal(claudeTokenLanded(saved("2026-10-26T10:05:00Z"), before), true);
  // The same last four is still a new token when its save is newer.
  assert.equal(claudeTokenLanded(saved("2026-10-26T10:05:00Z", "ab12"), before), true);
});

test("a reconnect can't be told done without a save time", () => {
  const before = saved(null);
  assert.equal(claudeTokenLanded(saved(null, "zz99"), before), false);
  // Disconnected meanwhile (another tab) isn't a landing either.
  assert.equal(claudeTokenLanded(none, before), false);
});

test("Settings and onboarding show the CLI for this app, named with --url", () => {
  assert.equal(
    connectClaudeCommand("npx", "http://localhost:3000"),
    "npx outrunner@latest --url http://localhost:3000 claude",
  );
});

test("with local sessions off, no way that only a Mac session can use is offered", () => {
  assert.deepEqual(
    authMethodsFor("claude", false).map((m) => m.id),
    ["subscription", "api-key"],
  );
  assert.deepEqual(
    authMethodsFor("codex", false).map((m) => m.id),
    ["codex-account", "api-key"],
  );
  // On, every way is.
  assert.ok(authMethodsFor("codex", true).some((m) => m.id === "chatgpt"));
  assert.ok(authMethodsFor("claude", true).some((m) => m.id === "local"));
});

/** A check whose answers the test hands out, one per look. */
function pendingChecks() {
  const answers: ((meta: ClaudeTokenMeta) => void)[] = [];
  const check = () => new Promise<ClaudeTokenMeta>((resolve) => answers.push(resolve));
  return { check, answers };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const watch = (check: () => Promise<ClaudeTokenMeta>, onLanded: (meta: ClaudeTokenMeta) => void, hidden = () => false) =>
  watchClaudeToken({ before: none, check, onLanded, everyMs: 3000, hidden, onVisible: () => () => {} });

test("an answer that comes after the watch stopped is dropped", async () => {
  const { check, answers } = pendingChecks();
  const landed: unknown[] = [];
  const stop = watch(check, (meta) => landed.push(meta));
  // Disconnect (or Cancel) while the first look is still out.
  stop();
  answers[0](saved("2026-10-26T10:00:00Z"));
  await settle();
  assert.deepEqual(landed, []);
});

test("a slow look isn't stacked on, and the token lands once", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { check, answers } = pendingChecks();
    const landed: unknown[] = [];
    watch(check, (meta) => landed.push(meta));
    mock.timers.tick(9000);
    // Three ticks while the first look was out: still one request.
    assert.equal(answers.length, 1);
    answers[0](none);
    await settle();
    mock.timers.tick(3000);
    assert.equal(answers.length, 2);
    answers[1](saved("2026-10-26T10:00:00Z"));
    await settle();
    mock.timers.tick(9000);
    // Landed: no more looks, and heard of once.
    assert.equal(answers.length, 2);
    assert.equal(landed.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a hidden page isn't looked from", () => {
  const { check, answers } = pendingChecks();
  const stop = watch(check, () => {}, () => true);
  assert.equal(answers.length, 0);
  stop();
});

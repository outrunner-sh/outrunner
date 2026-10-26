import assert from "node:assert/strict";
import { test } from "node:test";

import { authMethodsFor } from "@/lib/agents/registry";
import { claudeTokenLanded } from "@/lib/claude-connect";
import { connectClaudeCommand } from "@/lib/onboarding/rules";

const none = { connected: false, last4: null, updatedAt: null };
const saved = (updatedAt: string | null, last4 = "ab12") => ({ connected: true, last4, updatedAt });

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
    ["api-key"],
  );
  // On, every way is.
  assert.ok(authMethodsFor("codex", true).some((m) => m.id === "chatgpt"));
  assert.ok(authMethodsFor("claude", true).some((m) => m.id === "local"));
});

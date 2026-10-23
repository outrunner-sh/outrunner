import assert from "node:assert/strict";
import { test } from "node:test";

import { checkClaudeToken } from "@/lib/runtime/credentials/claude-token";

test("a subscription token is kept, trimmed", () => {
  const token = "sk-ant-oat01-" + "a".repeat(40);
  assert.deepEqual(checkClaudeToken(`  ${token}\n`), { token });
});

test("an opaque token in a new format still passes", () => {
  assert.deepEqual(checkClaudeToken("x".repeat(48)), { token: "x".repeat(48) });
});

test("junk is refused with the command to get a token", () => {
  for (const raw of [undefined, 42, "", "short", "has a space in it somewhere here", "a".repeat(501)]) {
    const checked = checkClaudeToken(raw);
    assert.ok("error" in checked && checked.error.includes("claude setup-token"), String(raw));
  }
});

test("an API key is sent to Providers, not saved as a subscription", () => {
  const checked = checkClaudeToken("sk-ant-api03-" + "a".repeat(40));
  assert.ok("error" in checked && checked.error.includes("Settings → Providers"));
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { messageForError, parseSetupToken } from "@/lib/desktop/connect-claude";

test("returns a bare sk-ant token as-is", () => {
  const token = "sk-ant-oat01-AbCd_1234-EfGh";
  assert.equal(parseSetupToken(token), token);
});

test("extracts an sk-ant token embedded in surrounding output", () => {
  const raw = "Token created successfully:\n  sk-ant-oat01-XYZ_9876abc\nDone.";
  assert.equal(parseSetupToken(raw), "sk-ant-oat01-XYZ_9876abc");
});

test("trims whitespace/newlines around a bare token", () => {
  assert.equal(parseSetupToken("  sk-ant-oat01-trimme_dvalue \n"), "sk-ant-oat01-trimme_dvalue");
});

test("accepts a long opaque single-line token without the sk-ant prefix", () => {
  const opaque = "a".repeat(48);
  assert.equal(parseSetupToken(opaque), opaque);
});

test("rejects non-strings, blanks, and prose without a token", () => {
  assert.equal(parseSetupToken(null), null);
  assert.equal(parseSetupToken(undefined), null);
  assert.equal(parseSetupToken(123), null);
  assert.equal(parseSetupToken(""), null);
  assert.equal(parseSetupToken("   "), null);
  assert.equal(parseSetupToken("Please log in to continue"), null);
});

test("rejects a too-short opaque value", () => {
  assert.equal(parseSetupToken("short-token"), null);
});

test("explains a CLI that exited without a token, with what it said", () => {
  const message = messageForError("setup-token-exited: Opening browser | Login failed");
  assert.match(message, /Claude Pro or Max subscription/);
  assert.match(message, /Settings → Credentials/);
  assert.match(message, /It said: Opening browser \| Login failed$/);
});

test("explains a CLI that exited without a token or any output", () => {
  const message = messageForError("setup-token-exited");
  assert.match(message, /stopped without issuing a token/);
  assert.doesNotMatch(message, /It said/);
});

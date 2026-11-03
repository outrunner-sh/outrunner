import assert from "node:assert/strict";
import { test } from "node:test";

import { reconnectReturnPath, safeRelativePath } from "@/lib/auth/redirect";

test("safeRelativePath falls back for empty/nullish input", () => {
  assert.equal(safeRelativePath(null), "/");
  assert.equal(safeRelativePath(undefined), "/");
  assert.equal(safeRelativePath(""), "/");
  assert.equal(safeRelativePath(null, "/home"), "/home");
});

test("safeRelativePath keeps same-origin relative paths", () => {
  assert.equal(safeRelativePath("/"), "/");
  assert.equal(safeRelativePath("/workspaces/123"), "/workspaces/123");
});

test("safeRelativePath rejects open-redirect attempts", () => {
  assert.equal(safeRelativePath("//evil.com"), "/");
  assert.equal(safeRelativePath("/\\evil.com"), "/");
  assert.equal(safeRelativePath("https://evil.com"), "/");
  assert.equal(safeRelativePath("evil.com"), "/");
});

test("reconnecting GitHub returns to the page it started from, without a stale link_error", () => {
  assert.equal(reconnectReturnPath("/w/abc", ""), "/w/abc");
  assert.equal(reconnectReturnPath("/w/abc", "?tab=env&link_error=x"), "/w/abc?tab=env");
  assert.equal(reconnectReturnPath("/settings/account", "?link_error=identity_already_exists"), "/settings/account");
  assert.equal(reconnectReturnPath("//evil.com", ""), "/");
});

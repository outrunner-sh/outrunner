import assert from "node:assert/strict";
import { test } from "node:test";

import { safeRelativePath } from "@/lib/auth/redirect";

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

test("safeRelativePath rejects what a browser reads as another origin", () => {
  // A Location's tabs and newlines are dropped and `\` is `/`, so each of
  // these is `//evil.com` to the browser following it.
  assert.equal(safeRelativePath("/\t/evil.com"), "/");
  assert.equal(safeRelativePath("/\n/evil.com"), "/");
  assert.equal(safeRelativePath("/\r\n/evil.com"), "/");
  assert.equal(safeRelativePath("/\t\\evil.com"), "/");
  assert.equal(safeRelativePath("/\t/evil.com", "/home"), "/home");
});

test("safeRelativePath keeps a path's query and hash", () => {
  assert.equal(safeRelativePath("/invite/abc?org=x#top"), "/invite/abc?org=x#top");
  assert.equal(safeRelativePath("/%09/evil.com"), "/%09/evil.com");
});

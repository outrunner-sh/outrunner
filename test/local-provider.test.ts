import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSafeRelativePath,
  parseChangedFiles,
  parseLineCounts,
} from "@/lib/runtime/git";

test("isSafeRelativePath accepts ordinary repository paths", () => {
  assert.equal(isSafeRelativePath("src/index.ts"), true);
  assert.equal(isSafeRelativePath("a/b/c.txt"), true);
  assert.equal(isSafeRelativePath("has spaces.txt"), true);
});

test("isSafeRelativePath rejects traversal, absolute, pathspec magic, and dot", () => {
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath("../etc/passwd"), false);
  assert.equal(isSafeRelativePath("a/../b"), false);
  assert.equal(isSafeRelativePath("/etc/passwd"), false);
  assert.equal(isSafeRelativePath(":(top)"), false);
  assert.equal(isSafeRelativePath("./a"), false);
});

test("parseChangedFiles joins -z name-status, numstat and untracked output", () => {
  const files = parseChangedFiles({
    nameStatus:
      "M\0src/a.ts\0A\0logo.png\0D\0gone.ts\0R087\0before.ts\0after.ts\0C75\0orig.ts\0copy.ts\0T\0link\0M\0tab\there.ts\0",
    // A rename's path field is empty, its old and new names follow; a binary
    // file counts "-"; a path may hold a tab.
    numstat:
      "3\t1\tsrc/a.ts\0-\t-\tlogo.png\0" +
      "0\t9\tgone.ts\0" +
      "2\t1\t\0before.ts\0after.ts\0" +
      "4\t0\t\0orig.ts\0copy.ts\0" +
      "1\t1\tlink\0" +
      "5\t0\ttab\there.ts\0",
    // gone.ts is out of the index but still on disk: listed once.
    untracked: "notes.txt\0gone.ts\0",
  });
  assert.deepEqual(
    files.map((f) => [f.status, f.path, f.additions, f.deletions]),
    [
      ["modified", "src/a.ts", 3, 1],
      ["added", "logo.png", 0, 0],
      ["deleted", "gone.ts", 0, 9],
      ["renamed", "after.ts", 2, 1],
      ["added", "copy.ts", 4, 0],
      ["modified", "link", 1, 1],
      ["modified", "tab\there.ts", 5, 0],
      ["untracked", "notes.txt", 0, 0],
    ],
  );
});

test("parseLineCounts reads git grep -c -z, whose paths may hold a newline", () => {
  const counts = parseLineCounts("a.txt\x002\nsub/new\nline.txt\x003\ntab\there.txt\x001\n");
  assert.deepEqual(
    [...counts],
    [
      ["a.txt", 2],
      ["sub/new\nline.txt", 3],
      ["tab\there.txt", 1],
    ],
  );
});

test("parseChangedFiles caps the change set at 500 files", () => {
  const untracked = Array.from({ length: 501 }, (_, i) => `f${i}\0`).join("");
  const files = parseChangedFiles({ nameStatus: "", numstat: "", untracked });
  assert.equal(files.length, 500);
});

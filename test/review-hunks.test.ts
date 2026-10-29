import assert from "node:assert/strict";
import { test } from "node:test";

import { splitHunks, toPullFiles } from "@/lib/review/hunks";

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " a",
  "-b",
  "+B",
  "+c",
  " d",
  "@@ -20,2 +21,2 @@ function f() {",
  "-x",
  "+y",
  "\\ No newline at end of file",
].join("\n");

test("a patch is cut into its hunks, each with an id and numbered lines", () => {
  const hunks = splitHunks("lib/a.ts", PATCH);
  assert.equal(hunks.length, 2);
  assert.deepEqual(
    hunks.map((h) => [h.id, h.index, h.header]),
    [
      ["lib/a.ts#0", 0, "@@ -1,3 +1,4 @@"],
      ["lib/a.ts#1", 1, "@@ -20,2 +21,2 @@ function f() {"],
    ],
  );
  assert.deepEqual(
    hunks[0].lines.map((l) => [l.type, l.oldNumber ?? null, l.newNumber ?? null]),
    [
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ],
  );
  // The no-newline marker stays with the hunk it ends.
  assert.equal(hunks[1].lines.length, 3);
});

test("a file with no patch has no hunks", () => {
  assert.deepEqual(splitHunks("logo.png", null), []);
  assert.deepEqual(splitHunks("empty", ""), []);
});

test("GitHub's file records become files with their kind", () => {
  const files = toPullFiles([
    { filename: "lib/a.ts", status: "modified", additions: 3, deletions: 1, patch: PATCH },
    { filename: "pnpm-lock.yaml", status: "modified", additions: 100, deletions: 50 },
    { filename: "test/new.test.ts", previous_filename: "test/old.test.ts", status: "renamed", additions: 0, deletions: 0 },
    { status: "added" },
    null,
  ]);
  assert.deepEqual(
    files.map((f) => [f.path, f.kind, f.status, f.previousPath, f.patch === null]),
    [
      ["lib/a.ts", "code", "modified", null, false],
      ["pnpm-lock.yaml", "generated", "modified", null, true],
      ["test/new.test.ts", "test", "renamed", "test/old.test.ts", true],
    ],
  );
});

test("a removed SQL comment stays a removed line, and the numbers after it hold", () => {
  // A removed `-- comment` and `--`, an added `++ counter` and `++`.
  const patch = ["@@ -1,4 +1,3 @@", "--- the old comment", "---", " select 1;", "+++ counter", "+++", "-x"].join("\n");
  const [hunk] = splitHunks("supabase/migrations/1.sql", patch);
  assert.deepEqual(
    hunk.lines.map((l) => [l.type, l.text, l.oldNumber ?? null, l.newNumber ?? null]),
    [
      ["del", "-- the old comment", 1, null],
      ["del", "--", 2, null],
      ["context", "select 1;", 3, 1],
      ["add", "++ counter", null, 2],
      ["add", "++", null, 3],
      ["del", "x", 4, null],
    ],
  );
});

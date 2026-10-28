import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUnifiedDiff } from "@/lib/runtime/diff";
import {
  addComment,
  type CommentQuote,
  type CommentStorage,
  clearComments,
  parseCommentQuotes,
  readComments,
  removeComment,
  selectionFromLines,
  subscribeComments,
  withComments,
} from "@/lib/session/diff-comments";

function memory(): CommentStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

// 0 hunk, 1 context(10/20), 2 del(11), 3 del(12), 4 add(21), 5 context(13/22), 6 hunk, 7 del(40)
const lines = parseUnifiedDiff(
  [
    "@@ -10,4 +20,3 @@",
    " keep",
    "-gone one",
    "-gone two",
    "+fresh",
    " tail",
    "@@ -40,1 +39,0 @@",
    "-dropped",
  ].join("\n"),
);

test("added lines are numbered in the new file and quoted without their marks", () => {
  assert.deepEqual(selectionFromLines(lines, 4, 4), { side: "new", startLine: 21, endLine: 21, code: "fresh" });
  // Either way round.
  assert.deepEqual(selectionFromLines(lines, 5, 4), { side: "new", startLine: 21, endLine: 22, code: "fresh\ntail" });
});

test("a range of removed lines alone is numbered in the old file", () => {
  assert.deepEqual(selectionFromLines(lines, 2, 3), {
    side: "old",
    startLine: 11,
    endLine: 12,
    code: "gone one\ngone two",
  });
});

test("a mixed range quotes the new file's lines, not the removed ones between them", () => {
  assert.deepEqual(selectionFromLines(lines, 1, 5), {
    side: "new",
    startLine: 20,
    endLine: 22,
    code: "keep\nfresh\ntail",
  });
});

test("hunk headers are skipped, and a range of nothing else is no selection", () => {
  assert.deepEqual(selectionFromLines(lines, 6, 7), { side: "old", startLine: 40, endLine: 40, code: "dropped" });
  assert.equal(selectionFromLines(lines, 0, 0), null);
  assert.equal(selectionFromLines(lines, 6, 6), null);
  // Body lines with no numbers (no hunk opened them) can't be pointed at.
  assert.equal(selectionFromLines(parseUnifiedDiff("+orphan"), 0, 0), null);
});

const quote = (over: Partial<CommentQuote> = {}): CommentQuote => ({
  path: "src/a.ts",
  side: "new",
  startLine: 12,
  endLine: 18,
  code: "const a = 1;\nconst b = 2;",
  comment: "Why two constants?",
  ...over,
});

test("comments ride after the prompt as quotes naming file, lines and code", () => {
  const sent = withComments("Tidy this up", [quote(), quote({ path: "README", startLine: 3, endLine: 3, code: "hi", comment: "Typo" })]);
  assert.equal(
    sent,
    [
      "Tidy this up",
      "",
      "Comments on the diff:",
      "",
      '<comment file="src/a.ts" lines="12-18">',
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
      "Why two constants?",
      "</comment>",
      "",
      '<comment file="README" lines="3">',
      "```",
      "hi",
      "```",
      "Typo",
      "</comment>",
    ].join("\n"),
  );
  // No comments, no change.
  assert.equal(withComments("just words", []), "just words");
});

test("a sent prompt reads back into its words and its quotes", () => {
  const comments = [
    quote(),
    quote({ side: "old", path: 'we"ird & path.md', startLine: 4, endLine: 4, code: "", comment: "Bring\nthis back" }),
  ];
  assert.deepEqual(parseCommentQuotes(withComments("Tidy this up\n\nplease", comments)), {
    text: "Tidy this up\n\nplease",
    quotes: comments,
  });
  // Comments alone.
  assert.deepEqual(parseCommentQuotes(withComments("", [quote()])), { text: "", quotes: [quote()] });
});

test("code with fences of its own is quoted in a longer fence and reads back whole", () => {
  const code = "Install:\n```sh\npnpm i\n```\n````\nmore";
  const sent = withComments("Look", [quote({ path: "docs/setup.md", code })]);
  assert.match(sent, /\n`````markdown\n/);
  assert.equal(parseCommentQuotes(sent).quotes[0].code, code);
});

test("a prompt that only looks like it has comments is left as typed", () => {
  for (const text of [
    "Comments on the diff: none, looks good",
    "Comments on the diff:\n\n<comment file=\"a\" lines=\"1\">\nunfenced\n</comment>",
    `${withComments("x", [quote()])}\n\nand one more thing`,
  ]) {
    assert.deepEqual(parseCommentQuotes(text), { text, quotes: [] });
  }
});

test("a session's comments are kept for the tab, and forgotten once none are left", () => {
  const storage = memory();
  let heard = 0;
  const stop = subscribeComments("w1", () => (heard += 1));
  const a = addComment(storage, "w1", quote());
  const b = addComment(storage, "w1", quote({ startLine: 30, endLine: 30 }));
  assert.equal(heard, 2);
  assert.deepEqual(readComments(storage, "w1"), [a, b]);
  // Read twice, unchanged: the same list (React's snapshot), not a copy.
  assert.equal(readComments(storage, "w1"), readComments(storage, "w1"));
  // Another session's are its own.
  assert.deepEqual(readComments(storage, "w2"), []);

  removeComment(storage, "w1", a.id);
  assert.deepEqual(readComments(storage, "w1"), [b]);
  // Clearing what a message carried leaves one written since.
  const c = addComment(storage, "w1", quote({ comment: "later" }));
  clearComments(storage, "w1", [b.id]);
  assert.deepEqual(readComments(storage, "w1"), [c]);
  clearComments(storage, "w1", [c.id]);
  assert.equal(storage.items.size, 0);
  assert.equal(heard, 6);
  // Nothing to clear: nothing to tell.
  clearComments(storage, "w1", ["gone"]);
  assert.equal(heard, 6);
  stop();
  addComment(storage, "w1", quote());
  assert.equal(heard, 6);
});

test("kept comments that can't be read are dropped, not sent", () => {
  const storage = memory();
  storage.setItem("outrunner:diff-comments:w1", "not json");
  assert.deepEqual(readComments(storage, "w1"), []);
  const ok = { id: "ok", ...quote() };
  storage.setItem(
    "outrunner:diff-comments:w1",
    JSON.stringify([
      ok,
      { ...ok, id: "blank", comment: "  " },
      { ...ok, id: "side", side: "both" },
      { ...ok, id: "backwards", startLine: 9, endLine: 3 },
      { ...ok, id: "zero", startLine: 0 },
      { ...quote() },
      null,
    ]),
  );
  assert.deepEqual(readComments(storage, "w1").map((c) => c.id), ["ok"]);
  // No storage at all (blocked): none, not a throw.
  assert.deepEqual(readComments(null, "w1"), []);
});

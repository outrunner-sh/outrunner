import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanTitle, TITLE_MAX, sessionTitle, titleToSet, workspaceLabel } from "@/lib/nav/session-title";

test("a title is the prompt's first non-empty line, whitespace collapsed", () => {
  assert.equal(sessionTitle("Fix the login redirect"), "Fix the login redirect");
  assert.equal(sessionTitle("\n\n  Fix   the\tlogin  \nthen add tests"), "Fix the login");
  assert.equal(sessionTitle("line one\r\nline two"), "line one");
});

test("no text means no title, so the next prompt gets to name the session", () => {
  assert.equal(sessionTitle(""), null);
  assert.equal(sessionTitle("   \n\t\n "), null);
});

test("a long line is cut at a word boundary with an ellipsis, within the limit", () => {
  const words = "refactor the authentication middleware so that every route ".repeat(3);
  const title = sessionTitle(words)!;
  assert.ok(title.length <= TITLE_MAX, `${title.length} > ${TITLE_MAX}`);
  assert.ok(title.endsWith("…"));
  assert.ok(words.startsWith(title.slice(0, -1)), "a prefix of the prompt");
  assert.ok(!title.slice(0, -1).endsWith(" "), "no space before the ellipsis");
  // Cut on a word boundary: the next character of the prompt is a space.
  assert.equal(words[title.length - 1], " ");
});

test("one enormous word is cut mid-word rather than reduced to nothing", () => {
  const title = sessionTitle("x".repeat(500))!;
  assert.equal(title.length, TITLE_MAX);
  assert.equal(title, `${"x".repeat(TITLE_MAX - 1)}…`);
});

test("a line exactly at the limit is kept whole", () => {
  const line = "y".repeat(TITLE_MAX);
  assert.equal(sessionTitle(line), line);
});

test("a cloud session shows its title, else its branch without runtime/", () => {
  assert.equal(workspaceLabel({ title: "Fix login", branch: "runtime/abc" }), "Fix login");
  assert.equal(workspaceLabel({ title: null, branch: "runtime/muyc8h2e-26700eb2" }), "muyc8h2e-26700eb2");
  assert.equal(workspaceLabel({ title: null, branch: "feat/x" }), "feat/x");
  assert.equal(workspaceLabel({ title: "", branch: "runtime/abc" }), "abc");
});

test("a session without a title takes one from the prompt", () => {
  assert.equal(titleToSet({ title: null }, "Pull latest code from main\nthen rebase"), "Pull latest code from main");
});

test("a session with a title is never renamed", () => {
  assert.equal(titleToSet({ title: "Fix OAuth redirect" }, "something else entirely"), null);
});

test("a session named from its prompt as it's made keeps that name when the prompt is delivered", () => {
  const prompt = "Fix the login redirect\nand add a test";
  const made = { title: titleToSet({ title: null }, prompt) };
  assert.equal(made.title, "Fix the login redirect");
  assert.equal(titleToSet(made, prompt), null);
});

test("a prompt with no text gives no title", () => {
  assert.equal(titleToSet({ title: null }, "  \n  "), null);
});

test("a renamed title is made one line and trimmed, within the limit (NEE-243)", () => {
  assert.equal(cleanTitle("  Fix the\n login   bug "), "Fix the login bug");
  assert.equal(cleanTitle("x".repeat(TITLE_MAX)), "x".repeat(TITLE_MAX));
  assert.equal(cleanTitle("x".repeat(TITLE_MAX + 1)), null);
  assert.equal(cleanTitle("   "), null);
  assert.equal(cleanTitle(undefined), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { changedOnly, insertMention, matchFiles, mentionAt, mentionOf, mentionSegments } from "@/lib/session/file-mentions";
import { newestDistinct, recallable, recallStep, searchHistory, withPrompt } from "@/lib/session/prompt-history";

const history = ["fix the flaky test", "open a PR", "Add dark mode to settings"];

test("↑ steps back through past prompts, ↓ forward, and past the newest gives the draft back", () => {
  let step = recallStep(history, null, "older", "");
  assert.deepEqual(step, { value: "fix the flaky test", recall: { index: 0, draft: "" } });
  step = recallStep(history, step!.recall, "older", step!.value);
  assert.equal(step?.value, "open a PR");
  step = recallStep(history, step!.recall, "older", step!.value);
  assert.equal(step?.value, "Add dark mode to settings");
  assert.equal(recallStep(history, step!.recall, "older", step!.value), null, "nothing older: the key does what it would");
  step = recallStep(history, step!.recall, "newer", step!.value);
  assert.equal(step?.value, "open a PR");
  step = recallStep(history, { index: 0, draft: "half typed" }, "newer", "fix the flaky test");
  assert.deepEqual(step, { value: "half typed", recall: null });
  assert.equal(recallStep(history, null, "newer", ""), null, "not recalling: ↓ is the caret's");
  assert.equal(recallStep([], null, "older", ""), null);
});

test("history keeps each prompt once, newest first, and not the composer's own commands", () => {
  assert.deepEqual(newestDistinct(["a", "b", "a", "c"]), ["a", "b", "c"]);
  assert.deepEqual(withPrompt(history, "  open a PR "), ["open a PR", "fix the flaky test", "Add dark mode to settings"]);
  assert.equal(withPrompt(history, "/compact keep tests"), history);
  assert.equal(withPrompt(history, "   "), history);
  assert.equal(recallable("x".repeat(20_001)), null);
});

test("Ctrl+R finds prompts holding every word typed, any case", () => {
  assert.deepEqual(searchHistory(history, "PR"), ["open a PR"]);
  assert.deepEqual(searchHistory(history, "dark settings"), ["Add dark mode to settings"]);
  assert.deepEqual(searchHistory(history, ""), history);
  assert.deepEqual(searchHistory(history, "dark nope"), []);
});

test("an @ at a word's start opens a mention; an address's doesn't", () => {
  assert.deepEqual(mentionAt("look at @src/ap", 15), { start: 8, query: "src/ap" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("mail me@host.com", 16), null);
  assert.equal(mentionAt("@src/app.ts done", 16), null, "past the space, the mention is over");
});

const files = ["lib/session/prompt-history.ts", "components/session-composer.tsx", "README.md", "lib/runtime/diff.ts", "test/diff.test.ts"];

test("files match fuzzily, a file's own name and runs of letters first", () => {
  assert.deepEqual(matchFiles(files, 1, "").slice(0, 2), ["lib/session/prompt-history.ts", "components/session-composer.tsx"]);
  assert.equal(matchFiles(files, 0, "composer")[0], "components/session-composer.tsx");
  assert.equal(matchFiles(files, 0, "diff.ts")[0], "lib/runtime/diff.ts", "the letters in a run");
  assert.equal(matchFiles(files, 0, "diff")[0], "test/diff.test.ts", "the shorter path for the same letters");
  assert.equal(matchFiles(files, 0, "phist")[0], "lib/session/prompt-history.ts");
  assert.deepEqual(matchFiles(files, 0, "zzz"), []);
  // A changed file ahead of an equal one.
  assert.equal(matchFiles(["b/diff.ts", "a/diff.ts"], 1, "diff")[0], "b/diff.ts");
});

test("a picked file goes in as @path, replacing what was typed after the @", () => {
  const text = "look at @comp and fix it";
  const at = mentionAt(text, 13)!;
  assert.deepEqual(insertMention(text, at, 13, "components/session-composer.tsx"), {
    text: "look at @components/session-composer.tsx and fix it",
    caret: 41,
  });
  assert.deepEqual(insertMention("@", { start: 0, query: "" }, 1, "README.md"), { text: "@README.md ", caret: 11 });
});

test("mentions of known files are drawn as pills; other @words aren't", () => {
  const known = new Set(["README.md"]);
  assert.deepEqual(mentionSegments("see @README.md and @nobody", known), [
    { text: "see ", mention: false },
    { text: "@README.md", mention: true },
    { text: " and @nobody", mention: false },
  ]);
  assert.deepEqual(mentionSegments("@README.md", known), [{ text: "@README.md", mention: true }]);
});

test("a path with a space goes in escaped, as Claude Code reads a mention, and is drawn whole", () => {
  // Claude Code 2.1.304 reads mentions as @((?:[^\s\\]|\\ )+), "\ " a space.
  assert.equal(mentionOf("docs/My Notes.md"), "@docs/My\\ Notes.md");
  const at = mentionAt("see @my", 7)!;
  assert.deepEqual(insertMention("see @my", at, 7, "docs/My Notes.md"), { text: "see @docs/My\\ Notes.md ", caret: 23 });
  assert.deepEqual(mentionSegments("see @docs/My\\ Notes.md now", new Set(["docs/My Notes.md"])), [
    { text: "see ", mention: false },
    { text: "@docs/My\\ Notes.md", mention: true },
    { text: " now", mention: false },
  ]);
});

test("a change set stands in as a listing of the changed files alone", () => {
  assert.deepEqual(
    changedOnly([
      { path: "src/a.ts", status: "modified" },
      { path: "gone.md", status: "deleted" },
      { path: "new.ts", status: "untracked" },
    ]),
    { files: ["src/a.ts", "new.ts"], changed: 2, truncated: true },
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { modelSwitch, parseAnswers, secretNames } from "@/lib/api/answers";

// As pending_input carries them (seen live: options are { label }).
const DB = { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] };
const TOOLS = { question: "Which tools?", options: [{ label: "Lint" }, { label: "Tests" }], multiSelect: true };

test("an answer per question: options picked, or words of its own", () => {
  assert.deepEqual(parseAnswers([{ selected: ["Postgres"] }], [DB]), [{ selected: ["Postgres"], other: "" }]);
  assert.deepEqual(parseAnswers([{ other: "MySQL, it's what we run" }, { selected: ["Lint", "Tests"] }], [DB, TOOLS]), [
    { selected: [], other: "MySQL, it's what we run" },
    { selected: ["Lint", "Tests"], other: "" },
  ]);
});

test("answers that don't fit the questions are refused", () => {
  assert.equal(typeof parseAnswers(undefined, [DB]), "string");
  assert.equal(typeof parseAnswers([], [DB]), "string");
  assert.match(parseAnswers([{ selected: ["Postgres"] }], [DB, TOOLS]) as string, /asked 2 questions/);
  assert.match(parseAnswers([{ selected: ["Postgres"] }, { selected: ["Lint"] }], [DB]) as string, /asked 1 question:/);
  assert.match(parseAnswers([{ selected: ["MongoDB"] }], [DB]) as string, /isn't one of question 1's options: Postgres, SQLite/);
  assert.match(parseAnswers([{ selected: ["Postgres", "SQLite"] }], [DB]) as string, /takes one option/);
  assert.equal(typeof parseAnswers([{ selected: "Postgres" }], [DB]), "string");
  assert.equal(typeof parseAnswers([{ other: 5 }], [DB]), "string");
  assert.equal(typeof parseAnswers([{}], [DB]), "string");
  assert.equal(typeof parseAnswers(["Postgres"], [DB]), "string");
});

test("a request for secrets names its variables as its keys' names", () => {
  // As pending_input carries them: found live, a session's request.
  assert.deepEqual(secretNames([{ name: "NEE253_TEST_SECRET" }, { name: "TOKEN", optional: true }]), ["NEE253_TEST_SECRET", "TOKEN"]);
  assert.deepEqual(secretNames(["PLAIN"]), ["PLAIN"]);
  assert.deepEqual(secretNames(undefined), []);
  assert.deepEqual(secretNames([{ nope: 1 }]), []);
});

test("an effort alone keeps the session's model; a model goes as named", () => {
  const current = { provider: "claude", id: "opus" };
  assert.deepEqual(modelSwitch({ effort: "high" }, current), { model: "opus", provider: "claude", effort: "high" });
  assert.deepEqual(modelSwitch({ model: "haiku" }, current), { model: "haiku" });
  assert.deepEqual(modelSwitch({ model: "glm", provider: "outrunner", effort: "low" }, null), { model: "glm", provider: "outrunner", effort: "low" });
  assert.equal(typeof modelSwitch({ effort: "high" }, null), "string");
  assert.equal(typeof modelSwitch({}, current), "string");
  assert.equal(typeof modelSwitch({ model: 5 }, current), "string");
});

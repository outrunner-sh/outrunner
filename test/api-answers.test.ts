import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAnswers } from "@/lib/api/answers";

test("an answer per question: options picked, or words of its own", () => {
  assert.deepEqual(parseAnswers([{ selected: ["Postgres"] }], 1), [{ selected: ["Postgres"], other: "" }]);
  assert.deepEqual(parseAnswers([{ other: "MySQL, it's what we run" }], 2), [{ selected: [], other: "MySQL, it's what we run" }]);
});

test("answers that don't fit the question are refused", () => {
  assert.equal(typeof parseAnswers(undefined, 1), "string");
  assert.equal(typeof parseAnswers([], 1), "string");
  assert.match(parseAnswers([{ selected: ["a"] }, { selected: ["b"] }], 1) as string, /asked 1 question\./);
  assert.equal(typeof parseAnswers([{ selected: "Postgres" }], 1), "string");
  assert.equal(typeof parseAnswers([{ other: 5 }], 1), "string");
  assert.equal(typeof parseAnswers([{}], 1), "string");
  assert.equal(typeof parseAnswers(["Postgres"], 1), "string");
});

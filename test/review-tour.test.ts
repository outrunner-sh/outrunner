import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { toPullFiles } from "@/lib/review/hunks";
import { normalizeTour, readJsonAnswer, salvageAnswer, tourHunks, tourPrompt, tourTokens, writeTour } from "@/lib/review/tour";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TWO_HUNKS = "@@ -1,2 +1,2 @@\n-a\n+b\n@@ -40,1 +40,2 @@\n x\n+y";
const ONE_HUNK = "@@ -1 +1 @@\n-old\n+new";

const files = toPullFiles([
  { filename: "test/api.test.ts", additions: 1, deletions: 1, patch: ONE_HUNK },
  { filename: "lib/api.ts", additions: 2, deletions: 1, patch: TWO_HUNKS },
  { filename: "lib/types.ts", additions: 1, deletions: 1, patch: ONE_HUNK },
  { filename: "pnpm-lock.yaml", additions: 300, deletions: 20, patch: ONE_HUNK },
  { filename: "logo.png", additions: 0, deletions: 0 },
]);

test("the tour walks code then tests, and leaves out generated and binary files", () => {
  const { hunks, skipped } = tourHunks(files);
  assert.deepEqual(
    hunks.map((h) => h.id),
    ["lib/api.ts#0", "lib/api.ts#1", "lib/types.ts#0", "test/api.test.ts#0"],
  );
  assert.deepEqual(skipped.sort(), ["logo.png", "pnpm-lock.yaml"]);
});

test("the prompt shows each hunk under its id, and only headers past the budget", () => {
  const { hunks } = tourHunks(files);
  const prompt = tourPrompt({ title: "Add an API", body: "Adds it." }, hunks);
  assert.match(prompt, /### lib\/api\.ts#1\n@@ -40,1 \+40,2 @@\n x\n\+y/);
  assert.match(prompt, /Adds it\./);

  const big = toPullFiles(
    Array.from({ length: 40 }, (_, i) => ({ filename: `lib/f${String(i).padStart(2, "0")}.ts`, patch: `@@ -1 +1 @@\n+${"x".repeat(3_900)}` })),
  );
  const long = tourPrompt({ title: "Big", body: "" }, tourHunks(big).hunks);
  assert.match(long, /### lib\/f39\.ts#0\n@@ -1 \+1 @@\n\(not shown: the diff is long\)/);
  assert.ok(long.length < 120_000);
});

test("the answer's JSON is found bare, fenced, or among words", () => {
  assert.deepEqual(readJsonAnswer('{"a":1}'), { a: 1 });
  assert.deepEqual(readJsonAnswer('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(readJsonAnswer('Sure! {"a":3} Hope that helps.'), { a: 3 });
  assert.equal(readJsonAnswer("no json here"), null);
});

test("the model's order is kept, held to the real hunks, each file's together", () => {
  const { hunks, skipped } = tourHunks(files);
  const tour = normalizeTour(
    {
      summary: "Adds an API.",
      steps: [
        { hunk: "lib/types.ts#0", title: "The type", explanation: "Defines it." },
        { hunk: "lib/api.ts#1", title: "Handler", explanation: "Uses it." },
        { hunk: "made/up.ts#0", title: "Ghost", explanation: "Not real." },
        { hunk: "test/api.test.ts#0", title: "Test", explanation: "Checks it." },
        { hunk: "lib/types.ts#0", title: "Again", explanation: "Twice." },
        // Back to a file already shown: it joins that file's hunks.
        { hunk: "lib/api.ts#0", title: "Import", explanation: "Wires it." },
      ],
    },
    hunks,
    skipped,
  );
  assert.equal(tour.summary, "Adds an API.");
  assert.deepEqual(
    tour.steps.map((s) => [s.hunkId, s.title]),
    [
      ["lib/types.ts#0", "The type"],
      ["lib/api.ts#1", "Handler"],
      ["lib/api.ts#0", "Import"],
      ["test/api.test.ts#0", "Test"],
    ],
  );
  assert.deepEqual(tour.skipped, skipped);
});

test("a hunk the model skipped is still in the tour, with its file", () => {
  const { hunks, skipped } = tourHunks(files);
  const tour = normalizeTour({ steps: [{ hunk: "lib/api.ts#1", title: "Handler", explanation: "x" }] }, hunks, skipped);
  assert.deepEqual(
    tour.steps.map((s) => s.hunkId),
    ["lib/api.ts#1", "lib/api.ts#0", "lib/types.ts#0", "test/api.test.ts#0"],
  );
  assert.equal(tour.steps[1].explanation, "");
});

test("with no usable answer, the tour runs in the plain order without notes", () => {
  const { hunks, skipped } = tourHunks(files);
  const tour = normalizeTour(null, hunks, skipped);
  assert.equal(tour.summary, "");
  assert.deepEqual(
    tour.steps.map((s) => s.hunkId),
    hunks.map((h) => h.id),
  );
});

test("writeTour asks the model once and normalizes its answer", async () => {
  let asked = 0;
  globalThis.fetch = (async () => {
    asked += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '```json\n{"summary":"S","steps":[{"hunk":"lib/types.ts#0","title":"T","explanation":"E"}]}\n```' } }] }),
    );
  }) as typeof fetch;
  const tour = await writeTour("key", { title: "t", body: "" }, files);
  assert.equal(asked, 1);
  assert.equal(tour.summary, "S");
  assert.equal(tour.steps[0].hunkId, "lib/types.ts#0");
  assert.equal(tour.steps.length, 4);

  // Nothing to walk through: no call at all.
  const none = await writeTour("key", { title: "t", body: "" }, toPullFiles([{ filename: "yarn.lock", patch: ONE_HUNK }]));
  assert.equal(asked, 1);
  assert.deepEqual(none, { summary: "", steps: [], skipped: ["yarn.lock"], complete: true });
});

test("an answer cut off mid-step keeps the steps it finished", async () => {
  const cut = '{"summary": "Adds \\"a\\".", "steps": [{"hunk": "lib/types.ts#0", "title": "T", "explanation": "E"}, {"hunk": "lib/api.ts#0", "title": "Hand';
  const saved = salvageAnswer(cut);
  assert.deepEqual(saved, { summary: 'Adds "a".', steps: [{ hunk: "lib/types.ts#0", title: "T", explanation: "E" }] });
  assert.equal(salvageAnswer("no steps at all"), null);

  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: cut }, finish_reason: "length" }] }))) as typeof fetch;
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (message: string) => warned.push(message);
  try {
    const tour = await writeTour("key", { title: "t", body: "" }, files);
    assert.equal(tour.summary, 'Adds "a".');
    assert.deepEqual([tour.steps[0].hunkId, tour.steps[0].explanation], ["lib/types.ts#0", "E"]);
    assert.equal(tour.steps.length, 4);
  } finally {
    console.warn = warn;
  }
  assert.match(warned[0], /finish_reason length/);
});

test("the answer's tokens grow with the hunks, to a ceiling; a long tour asks for short notes", () => {
  assert.equal(tourTokens(10), 3_000);
  assert.equal(tourTokens(500), 16_000);
  const many = toPullFiles(Array.from({ length: 61 }, (_, i) => ({ filename: `lib/m${i}.ts`, patch: ONE_HUNK })));
  assert.match(tourPrompt({ title: "t", body: "" }, tourHunks(many).hunks), /keep each explanation to one sentence/);
  assert.doesNotMatch(tourPrompt({ title: "t", body: "" }, tourHunks(files).hunks), /one sentence\./);
});

test("a tour of only some of the PR's files says so, to the model and on the card", async () => {
  const { hunks } = tourHunks(files);
  assert.match(tourPrompt({ title: "t", body: "" }, hunks, false), /only some of its files/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))) as typeof fetch;
  assert.equal((await writeTour("key", { title: "t", body: "" }, files, false)).complete, false);
});

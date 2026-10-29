import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { countLines } from "@/lib/review/line-kinds";
import { pullFiles } from "@/lib/review/files";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ filename: `lib/f${from + i}.ts`, additions: 1, deletions: 0 }));

function serve(pages: (unknown[] | null)[]) {
  const asked: number[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const n = Number(new URL(String(input)).searchParams.get("page"));
    asked.push(n);
    const body = pages[n - 1];
    return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 502 });
  }) as typeof fetch;
  return asked;
}

test("a PR's files are read page by page until a short one", async () => {
  const asked = serve([page(100), page(30, 100)]);
  const read = await pullFiles("t", "acme/repo", 7);
  assert.equal(read?.files.length, 130);
  assert.equal(read?.complete, true);
  assert.deepEqual(asked, [1, 2]);
});

test("files GitHub didn't list say so, rather than read as none", async () => {
  serve([null]);
  assert.equal(await pullFiles("t", "acme/repo", 7), null);
  serve([page(100), null]);
  const partial = await pullFiles("t", "acme/repo", 7);
  assert.deepEqual([partial?.files.length, partial?.complete], [100, false]);
});

test("the inbox reads one page, partial past it", async () => {
  const asked = serve([page(100), page(100, 100)]);
  const read = await pullFiles("t", "acme/repo", 7, 1);
  assert.deepEqual([read?.files.length, read?.complete], [100, false]);
  assert.deepEqual(asked, [1]);
});

test("counting takes a file's kind as already worked out", () => {
  assert.deepEqual(countLines([{ path: "lib/a.ts", kind: "generated", additions: 5, deletions: 1 }]).generated, { additions: 5, deletions: 1 });
});

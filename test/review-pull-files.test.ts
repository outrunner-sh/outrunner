import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { inboxFileCounts, pullFiles } from "@/lib/review/files";
import { byKindThenPath, countLines } from "@/lib/review/line-kinds";

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

test("the inbox counts lines in one GraphQL call a repository, without patches", async () => {
  const sent: { query: string; variables: unknown }[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        data: {
          repository: {
            p7: {
              files: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { path: "lib/a.ts", additions: 3, deletions: 1 },
                  { path: "pnpm-lock.yaml", additions: 90, deletions: 9 },
                ],
              },
            },
            p8: { files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "test/a.test.ts", additions: 2, deletions: 0 }] } },
            p9: null,
          },
        },
      }),
    );
  }) as typeof fetch;
  const counts = await inboxFileCounts("t", "acme/repo", [7, 8, 9, 7]);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].query, /patch/);
  assert.match(sent[0].query, /p7: pullRequest\(number: 7\)/);
  assert.deepEqual(sent[0].variables, { owner: "acme", name: "repo" });
  assert.deepEqual(counts.get(7), {
    lines: { code: { additions: 3, deletions: 1 }, test: { additions: 0, deletions: 0 }, generated: { additions: 90, deletions: 9 } },
    complete: true,
  });
  // More than 100 files: partial, by GitHub's own word rather than a guess.
  assert.equal(counts.get(8)?.complete, false);
  assert.equal(counts.has(9), false);
});

test("the inbox shows no counts when GitHub doesn't answer", async () => {
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal((await inboxFileCounts("t", "acme/repo", [7])).size, 0);
});

test("files sort code, then tests, then generated, by path in one locale", () => {
  const files = [
    { kind: "generated" as const, path: "pnpm-lock.yaml" },
    { kind: "test" as const, path: "test/z.test.ts" },
    { kind: "code" as const, path: "lib/z.ts" },
    { kind: "code" as const, path: "lib/s.ts" },
    { kind: "code" as const, path: "lib/t.ts" },
  ];
  // Estonian sorts z right after s; the files view must not, wherever it runs.
  assert.deepEqual(
    [...files].sort(byKindThenPath).map((f) => f.path),
    ["lib/s.ts", "lib/t.ts", "lib/z.ts", "test/z.test.ts", "pnpm-lock.yaml"],
  );
});

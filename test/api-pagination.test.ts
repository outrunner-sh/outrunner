import assert from "node:assert/strict";
import { test } from "node:test";

import { pageOf, pageRequest, paginate } from "@/lib/api/pagination";

const q = (query: string) => new URLSearchParams(query);

test("a page is 1 of 20 unless asked", () => {
  assert.deepEqual(pageRequest(q("")), { page: 1, perPage: 20 });
  assert.deepEqual(pageRequest(q("page=3&per_page=100")), { page: 3, perPage: 100 });
});

test("pages out of range are refused with why", () => {
  assert.equal(typeof pageRequest(q("page=0")), "string");
  assert.equal(typeof pageRequest(q("per_page=101")), "string");
  assert.equal(typeof pageRequest(q("page=two")), "string");
});

test("a page says how many there are and whether more follow", () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(paginate(items, { page: 3, perPage: 20 }), {
    data: [40, 41, 42, 43, 44],
    page: 3,
    per_page: 20,
    total: 45,
    total_pages: 3,
    has_more: false,
  });
  assert.equal(paginate(items, { page: 1, perPage: 20 }).has_more, true);
  assert.deepEqual(pageOf([], 0, { page: 1, perPage: 20 }), { data: [], page: 1, per_page: 20, total: 0, total_pages: 0, has_more: false });
});

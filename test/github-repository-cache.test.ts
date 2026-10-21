import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { GitHubRepositoryList } from "@/lib/github/client";
import {
  cachedRepositoryList,
  clearRepositoryCache,
  REPOSITORY_CACHE_TTL_MS,
} from "@/lib/github/repository-cache";

afterEach(clearRepositoryCache);

function listing(count: number): GitHubRepositoryList {
  return { repositories: [], complete: true, ssoPartialOrgIds: Array.from({ length: count }, (_, i) => i + 1) };
}

test("a listing is reused for a while, per user, and read anew when fresh or expired", async () => {
  let loads = 0;
  const load = () => Promise.resolve(listing(++loads));

  // Two at once share one read.
  const [a, b] = await Promise.all([
    cachedRepositoryList("u1", load, { now: 0 }),
    cachedRepositoryList("u1", load, { now: 1 }),
  ]);
  assert.equal(a, b);
  assert.equal(loads, 1);

  // Another user has their own.
  await cachedRepositoryList("u2", load, { now: 2 });
  assert.equal(loads, 2);

  // Fresh reads anew, and that is what is reused after.
  const fresh = await cachedRepositoryList("u1", load, { fresh: true, now: 3 });
  assert.equal(loads, 3);
  assert.equal(await cachedRepositoryList("u1", load, { now: 4 }), fresh);

  // Expired: read anew.
  await cachedRepositoryList("u1", load, { now: 3 + REPOSITORY_CACHE_TTL_MS });
  assert.equal(loads, 4);
});

test("a failed listing isn't kept, so the next call tries again", async () => {
  await assert.rejects(cachedRepositoryList("u1", () => Promise.reject(new Error("down")), { now: 0 }));
  const list = await cachedRepositoryList("u1", () => Promise.resolve(listing(1)), { now: 1 });
  assert.deepEqual(list.ssoPartialOrgIds, [1]);
});

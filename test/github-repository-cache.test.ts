import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { GitHubRepositoryList } from "@/lib/github/client";
import {
  cachedRepositoryList as cachedWithRead,
  clearRepositoryCache,
  forgetRepositoryList,
  REPOSITORY_CACHE_TTL_MS,
} from "@/lib/github/repository-cache";

afterEach(clearRepositoryCache);

/** Just the listing, for the tests about which one comes back. */
async function cachedRepositoryList(...args: Parameters<typeof cachedWithRead>) {
  return (await cachedWithRead(...args)).list;
}

/** A listing told apart by how many orgs it names. */
function listing(count: number): GitHubRepositoryList {
  return { repositories: [], complete: true, ssoPartialOrgIds: Array.from({ length: count }, (_, i) => i + 1) };
}

test("a listing is reused for a while, per user, and read anew when fresh or expired", async () => {
  let time = 0;
  const clock = () => time;
  let loads = 0;
  const load = () => Promise.resolve(listing(++loads));

  // Two at once share one read.
  const [a, b] = await Promise.all([
    cachedRepositoryList("u1", load, { clock }),
    cachedRepositoryList("u1", load, { clock }),
  ]);
  assert.equal(a, b);
  assert.equal(loads, 1);

  // Another user has their own.
  await cachedRepositoryList("u2", load, { clock });
  assert.equal(loads, 2);

  // Fresh reads anew, and that is what is reused after.
  const fresh = await cachedRepositoryList("u1", load, { fresh: true, clock });
  assert.equal(loads, 3);
  assert.equal(await cachedRepositoryList("u1", load, { clock }), fresh);

  // Expired: read anew.
  time += REPOSITORY_CACHE_TTL_MS;
  await cachedRepositoryList("u1", load, { clock });
  assert.equal(loads, 4);
});

test("a listing slower than the cache lifetime is still shared, and lasts from when it came in", async () => {
  let time = 0;
  const clock = () => time;
  let loads = 0;
  let finish: (list: GitHubRepositoryList) => void = () => {};
  const slow = () => {
    loads += 1;
    return new Promise<GitHubRepositoryList>((resolve) => {
      finish = resolve;
    });
  };

  const first = cachedRepositoryList("u1", slow, { clock });
  time += REPOSITORY_CACHE_TTL_MS * 2;
  const second = cachedRepositoryList("u1", slow, { clock });
  assert.equal(loads, 1);

  finish(listing(1));
  assert.equal(await first, await second);

  time += REPOSITORY_CACHE_TTL_MS - 1;
  await cachedRepositoryList("u1", slow, { clock });
  assert.equal(loads, 1);
});

test("a failed listing isn't kept, so the next call tries again", async () => {
  await assert.rejects(cachedRepositoryList("u1", () => Promise.reject(new Error("down"))));
  const list = await cachedRepositoryList("u1", () => Promise.resolve(listing(1)));
  assert.deepEqual(list.ssoPartialOrgIds, [1]);
});

test("only the call that read a listing is told it read it, and a forgotten one is read again", async () => {
  let loads = 0;
  const load = () => Promise.resolve(listing(++loads));

  const [a, b] = await Promise.all([cachedWithRead("u1", load), cachedWithRead("u1", load)]);
  assert.deepEqual([a.readNow, b.readNow], [true, false]);
  assert.equal((await cachedWithRead("u1", load)).readNow, false);

  forgetRepositoryList("u1");
  assert.equal((await cachedWithRead("u1", load)).readNow, true);
  assert.equal(loads, 2);
});

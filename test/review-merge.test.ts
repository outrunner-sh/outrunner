import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  allowedMethods,
  enqueuePullRequest,
  getMergeAccess,
  GitHubSyncError,
  type MergeAccess,
  mergeMethod,
  mergePullRequest,
  type PullRequestStatus,
} from "@/lib/github/client";
import { mergeOffer, refuseMerge } from "@/lib/review/merge-plan";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setFetchByPath(routes: Record<string, (body: unknown) => Response>) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const route = routes[url.pathname];
    return Promise.resolve(route ? route(body) : new Response("{}", { status: 404 }));
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  state: "open",
  draft: false,
  mergeableState: "clean",
  headSha: "s1",
  checks: { passing: 2, failing: 0, pending: 0 },
  ...over,
});

const access = (over: Partial<MergeAccess> = {}): MergeAccess => ({
  pullId: "PR_1",
  canBypass: false,
  mergeQueue: false,
  queuePosition: null,
  methods: null,
  ...over,
});

test("a clean PR offers a plain Merge, and no bypass even to an admin", () => {
  assert.deepEqual(mergeOffer(status(), access({ canBypass: true })), {
    primary: { action: "merge", label: "Merge", why: null },
    bypass: false,
  });
});

test("a blocked PR offers bypass only to someone GitHub lets past the rules", () => {
  const blocked = status({ mergeableState: "blocked" });
  assert.equal(mergeOffer(blocked, access()).bypass, false);
  assert.equal(mergeOffer(blocked, null).bypass, false);
  const offer = mergeOffer(blocked, access({ canBypass: true }));
  assert.equal(offer.bypass, true);
  assert.equal(offer.primary.action, "merge");
  assert.match((offer.primary as { why: string }).why, /required review or check/);
  // Failing checks and a branch behind its base are the rules' too.
  assert.equal(mergeOffer(status({ checks: { passing: 0, failing: 1, pending: 0 } }), access({ canBypass: true })).bypass, true);
  assert.equal(mergeOffer(status({ mergeableState: "behind" }), access({ canBypass: true })).bypass, true);
});

test("no bypass merges a draft or a PR with conflicts", () => {
  assert.equal(mergeOffer(status({ draft: true, mergeableState: "blocked" }), access({ canBypass: true })).bypass, false);
  assert.equal(mergeOffer(status({ mergeableState: "dirty" }), access({ canBypass: true })).bypass, false);
});

test("a branch with a merge queue offers the queue, and bypass to skip it", () => {
  const offer = mergeOffer(status({ mergeableState: "blocked" }), access({ mergeQueue: true, canBypass: true }));
  assert.deepEqual(offer.primary, { action: "queue", label: "Merge when ready", why: null });
  assert.equal(offer.bypass, true);
  // The queue runs pending checks itself, but won't take failing ones.
  assert.equal((mergeOffer(status({ checks: { passing: 0, failing: 0, pending: 3 } }), access({ mergeQueue: true })).primary as { why: unknown }).why, null);
  assert.equal(
    (mergeOffer(status({ checks: { passing: 0, failing: 1, pending: 0 } }), access({ mergeQueue: true })).primary as { why: unknown }).why,
    "Checks are failing.",
  );
});

test("a PR in the queue shows its place", () => {
  assert.deepEqual(mergeOffer(status(), access({ mergeQueue: true, queuePosition: 3 })).primary, { action: "queued", position: 3 });
});

test("the route never lets a plain Merge bypass the rules", () => {
  const blocked = status({ mergeableState: "blocked" });
  assert.match(refuseMerge("merge", blocked, access({ canBypass: true })) ?? "", /required review/);
  assert.equal(refuseMerge("bypass", blocked, access({ canBypass: true })), null);
  assert.match(refuseMerge("bypass", blocked, access()) ?? "", /can't bypass/);
  assert.match(refuseMerge("bypass", status(), access({ canBypass: true })) ?? "", /without bypassing/);
  assert.match(refuseMerge("merge", status(), access({ mergeQueue: true })) ?? "", /merge queue/);
  assert.equal(refuseMerge("queue", status(), access({ mergeQueue: true })), null);
  assert.match(refuseMerge("queue", status(), access()) ?? "", /no merge queue/);
  assert.equal(refuseMerge("merge", status(), null), null);
});

test("the rules' allowed merge methods narrow what the repository allows", () => {
  const rules = [
    { type: "required_status_checks", parameters: {} },
    { type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } },
    { type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
  ];
  assert.deepEqual(allowedMethods(rules), ["squash"]);
  assert.equal(allowedMethods([{ type: "deletion" }]), null);
  assert.equal(allowedMethods({ message: "Not Found" }), null);
  assert.equal(mergeMethod({}, ["squash"]), "squash");
  assert.equal(mergeMethod({ allow_squash_merge: false }, ["squash"]), null);
  assert.equal(mergeMethod({}, null), "merge");
});

test("getMergeAccess reads GitHub's own word on bypassing and the queue", async () => {
  const seen = setFetchByPath({
    "/graphql": () =>
      json({
        data: {
          repository: {
            pullRequest: { id: "PR_kw", viewerCanMergeAsAdmin: true, isMergeQueueEnabled: true, isInMergeQueue: true, mergeQueueEntry: { position: 2 } },
          },
        },
      }),
    "/repos/acme/repo/rules/branches/release/v1": () => json([{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } }]),
  });
  const result = await getMergeAccess({ token: "t", repoFullName: "acme/repo", number: 7, baseRef: "release/v1" });
  assert.deepEqual(result, { pullId: "PR_kw", canBypass: true, mergeQueue: true, queuePosition: 2, methods: ["rebase"] });
  const query = seen.find((r) => r.path === "/graphql");
  assert.deepEqual((query?.body as { variables: unknown }).variables, { owner: "acme", name: "repo", number: 7 });
});

test("getMergeAccess passes on GitHub's GraphQL refusal", async () => {
  setFetchByPath({
    "/graphql": () => json({ data: null, errors: [{ message: "Could not resolve to a Repository" }] }),
  });
  await assert.rejects(
    getMergeAccess({ token: "t", repoFullName: "acme/repo", number: 7, baseRef: "main" }),
    (error: unknown) => error instanceof GitHubSyncError && /Could not resolve/.test(error.message),
  );
});

test("enqueuePullRequest adds it at the seen commit", async () => {
  const seen = setFetchByPath({
    "/graphql": () => json({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 4 } } } }),
  });
  assert.deepEqual(await enqueuePullRequest({ token: "t", pullId: "PR_kw", headSha: "s1" }), { position: 4 });
  assert.deepEqual((seen[0].body as { variables: unknown }).variables, { id: "PR_kw", sha: "s1" });
});

test("mergePullRequest merges by a method the rules allow", async () => {
  const seen = setFetchByPath({
    "/repos/acme/repo": () => json({ allow_merge_commit: true, allow_squash_merge: true }),
    "/repos/acme/repo/pulls/7/merge": () => json({ merged: true }),
  });
  await mergePullRequest({ token: "t", repoFullName: "acme/repo", number: 7, headSha: "s1", methods: ["squash"] });
  assert.deepEqual(seen.find((r) => r.path.endsWith("/merge"))?.body, { sha: "s1", merge_method: "squash" });
});

test("getMergeAccess reads every page of the branch's rules", async () => {
  const pages: string[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      return Promise.resolve(json({ data: { repository: { pullRequest: { id: "PR_kw", viewerCanMergeAsAdmin: false } } } }));
    }
    const page = url.searchParams.get("page") ?? "?";
    pages.push(page);
    // The pull_request rule that narrows the methods is on the second page.
    return Promise.resolve(
      page === "1"
        ? json(Array.from({ length: 100 }, () => ({ type: "required_signatures" })))
        : json([{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }]),
    );
  }) as typeof fetch;
  const result = await getMergeAccess({ token: "t", repoFullName: "acme/repo", number: 7, baseRef: "main" });
  assert.deepEqual(pages, ["1", "2"]);
  assert.deepEqual(result.methods, ["squash"]);
});

test("a failed read of the rules is logged, and a 404 is none", async () => {
  const logged: unknown[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    for (const status of [404, 503]) {
      globalThis.fetch = ((input: Parameters<typeof fetch>[0]) =>
        Promise.resolve(
          new URL(String(input)).pathname === "/graphql"
            ? json({ data: { repository: { pullRequest: { id: "PR_kw" } } } })
            : json({ message: "no" }, status),
        )) as typeof fetch;
      assert.equal((await getMergeAccess({ token: "t", repoFullName: "acme/repo", number: 7, baseRef: "main" })).methods, null);
    }
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1);
  assert.match(String((logged[0] as unknown[])[0]), /wouldn't list acme\/repo's rules/);
});

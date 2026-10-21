import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  findOrCreatePullRequest,
  getGitHubRepository,
  GitHubSyncError,
  listGitHubRepositories,
} from "@/lib/github/client";

const realFetch = globalThis.fetch;

/** Stub global fetch with a handler that receives the request method. */
function setFetch(handler: (method: string) => Response): void {
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const method = (args[1]?.method ?? "GET").toString();
    return Promise.resolve(handler(method));
  }) as typeof fetch;
}

/** Stub global fetch with a handler that receives the GET URL. */
function setFetchByUrl(handler: (url: URL) => Response): URL[] {
  const seen: URL[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    seen.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return seen;
}

/** A /user/repos record as GitHub sends it. */
function apiRepo(id: number, pushedAt: string | null, owner = "acme") {
  return {
    id,
    full_name: `${owner}/repo-${id}`,
    name: `repo-${id}`,
    owner: { login: owner, type: "Organization", avatar_url: `https://avatars/${owner}` },
    default_branch: "main",
    private: true,
    language: null,
    description: null,
    html_url: `https://github.com/${owner}/repo-${id}`,
    pushed_at: pushedAt,
  };
}

/** A page of /user/repos, with the `Link` header GitHub puts on page 1. */
function reposPage(records: unknown[], init: { lastPage?: number; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.lastPage) {
    headers.set(
      "link",
      `<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?per_page=100&page=${init.lastPage}>; rel="last"`,
    );
  }
  return new Response(JSON.stringify(records), { status: 200, headers });
}

const PR_INPUT = {
  token: "gh-test-token",
  repoFullName: "owner/repo",
  headBranch: "runtime/x",
  baseBranch: "main",
  title: "t",
  body: "",
};

beforeEach(() => {
  process.env.GITHUB_PAT = "ghp_test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("findOrCreatePullRequest returns an existing open PR without creating one", async () => {
  let posts = 0;
  setFetch((method) => {
    if (method === "POST") {
      posts += 1;
      return new Response("{}", { status: 201 });
    }
    return new Response(JSON.stringify([{ number: 7, html_url: "https://gh/pr/7" }]), { status: 200 });
  });

  const pr = await findOrCreatePullRequest(PR_INPUT);
  assert.deepEqual(pr, { number: 7, url: "https://gh/pr/7" });
  assert.equal(posts, 0);
});

test("findOrCreatePullRequest creates a PR when none exists", async () => {
  setFetch((method) =>
    method === "POST"
      ? new Response(JSON.stringify({ number: 9, html_url: "https://gh/pr/9" }), { status: 201 })
      : new Response("[]", { status: 200 }),
  );

  const pr = await findOrCreatePullRequest(PR_INPUT);
  assert.deepEqual(pr, { number: 9, url: "https://gh/pr/9" });
});

test("findOrCreatePullRequest re-looks up the PR on a 422 (concurrent create)", async () => {
  let lookups = 0;
  setFetch((method) => {
    if (method === "POST") return new Response("{}", { status: 422 });
    lookups += 1;
    // First lookup empty (so we attempt create), second finds the racing PR.
    return new Response(
      JSON.stringify(lookups >= 2 ? [{ number: 5, html_url: "https://gh/pr/5" }] : []),
      { status: 200 },
    );
  });

  const pr = await findOrCreatePullRequest(PR_INPUT);
  assert.deepEqual(pr, { number: 5, url: "https://gh/pr/5" });
});

test("listGitHubRepositories reads every page the first one names, newest push first", async () => {
  const seen = setFetchByUrl((url) => {
    const page = Number(url.searchParams.get("page"));
    if (page === 1) return reposPage([apiRepo(1, "2026-01-01T00:00:00Z")], { lastPage: 3 });
    if (page === 2) return reposPage([apiRepo(2, null)]);
    return reposPage([apiRepo(3, "2026-03-01T00:00:00Z")]);
  });

  const list = await listGitHubRepositories("t");

  assert.deepEqual(
    list.repositories.map((r) => r.githubRepoId),
    [3, 1, 2],
  );
  assert.equal(list.complete, true);
  assert.deepEqual(list.ssoPartialOrgIds, []);
  assert.deepEqual(
    seen.map((u) => u.searchParams.get("page")).sort(),
    ["1", "2", "3"],
  );
  // Sorted by name for GitHub, so concurrent pages can't shift under a push.
  assert.ok(seen.every((u) => u.searchParams.get("sort") === "full_name"));
  assert.equal(list.repositories[0].ownerType, "Organization");
  assert.equal(list.repositories[0].avatarUrl, "https://avatars/acme");
});

test("listGitHubRepositories gathers the orgs SSO left out and drops a repo seen twice", async () => {
  setFetchByUrl((url) =>
    url.searchParams.get("page") === "1"
      ? reposPage([apiRepo(1, null)], {
          lastPage: 2,
          headers: { "x-github-sso": "partial-results; organizations=21955855,20582480" },
        })
      : reposPage([apiRepo(1, null), apiRepo(2, null)], {
          headers: { "x-github-sso": "partial-results; organizations=20582480" },
        }),
  );

  const list = await listGitHubRepositories("t");

  assert.deepEqual(
    list.repositories.map((r) => r.githubRepoId).sort(),
    [1, 2],
  );
  assert.deepEqual(list.ssoPartialOrgIds.sort(), [20582480, 21955855]);
});

test("listGitHubRepositories skips a record it can't read, and says the list may be short", async () => {
  setFetchByUrl(() => reposPage([apiRepo(1, null), { id: "nope" }, null, apiRepo(2, null)]));

  const list = await listGitHubRepositories("t");

  assert.deepEqual(
    list.repositories.map((r) => r.githubRepoId).sort(),
    [1, 2],
  );
  assert.equal(list.complete, false);
});

test("listGitHubRepositories stops at 100 pages without failing", async () => {
  const seen = setFetchByUrl((url) =>
    url.searchParams.get("page") === "1"
      ? reposPage([apiRepo(1, null)], { lastPage: 150 })
      : reposPage([apiRepo(Number(url.searchParams.get("page")), null)]),
  );

  const list = await listGitHubRepositories("t");

  assert.equal(seen.length, 100);
  assert.equal(list.repositories.length, 100);
  assert.equal(list.complete, false);
});

test("listGitHubRepositories fails on a rejected token with a safe message", async () => {
  setFetchByUrl(() => new Response('{"message":"Bad credentials"}', { status: 401 }));

  await assert.rejects(listGitHubRepositories("t"), (error: unknown) => {
    assert.ok(error instanceof GitHubSyncError);
    assert.equal(error.status, 401);
    assert.equal(error.message, "GitHub could not authorize the configured token.");
    return true;
  });
});

test("getGitHubRepository: null for what the token can't see, an error for a rate limit", async () => {
  const seen = setFetchByUrl((url) => {
    if (url.pathname === "/repositories/7") return new Response(JSON.stringify(apiRepo(7, null)));
    if (url.pathname === "/repositories/404") return new Response("{}", { status: 404 });
    // An organization's SAML single sign-on the token isn't authorized for.
    if (url.pathname === "/repos/acme/sso") {
      return new Response("{}", { status: 403, headers: { "x-github-sso": "required; url=https://x" } });
    }
    return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
  });

  assert.equal((await getGitHubRepository("t", 7))?.fullName, "acme/repo-7");
  assert.equal(await getGitHubRepository("t", 404), null);
  assert.equal(await getGitHubRepository("t", "acme/sso"), null);
  await assert.rejects(getGitHubRepository("t", "acme/limited"), GitHubSyncError);

  // Never sent: not a repository name GitHub allows.
  const before = seen.length;
  assert.equal(await getGitHubRepository("t", "../user"), null);
  assert.equal(await getGitHubRepository("t", "acme/repo/extra"), null);
  assert.equal(await getGitHubRepository("t", -1), null);
  assert.equal(seen.length, before);
});

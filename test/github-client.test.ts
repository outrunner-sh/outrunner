import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  findPullRequest,
  getGitHubRepository,
  GitHubReconnectError,
  GitHubSyncError,
  listGitHubRepositories,
  MissingGithubTokenError,
} from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";

const realFetch = globalThis.fetch;

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

const PR_LOOKUP = { token: "gh-test-token", repoFullName: "acme/repo", headBranch: "runtime/x" };

/** A /pulls record as GitHub sends it. */
function apiPull(number: number, base = "main") {
  return { number, html_url: `https://gh/pr/${number}`, title: `PR ${number}`, base: { ref: base } };
}

beforeEach(() => {
  process.env.GITHUB_PAT = "ghp_test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("findPullRequest asks for the branch's newest PR in any state, from the repo's owner", async () => {
  const seen = setFetchByUrl(() => new Response(JSON.stringify([apiPull(7, "develop")]), { status: 200 }));

  const pr = await findPullRequest(PR_LOOKUP);
  assert.deepEqual(pr, { number: 7, url: "https://gh/pr/7", title: "PR 7", baseBranch: "develop" });
  const url = seen[0];
  assert.equal(url.pathname, "/repos/acme/repo/pulls");
  // A merged or closed PR still counts: the agent may finish before a look.
  assert.equal(url.searchParams.get("state"), "all");
  assert.equal(url.searchParams.get("head"), "acme:runtime/x");
  assert.equal(url.searchParams.get("direction"), "desc");
});

test("findPullRequest is null while the branch has no PR", async () => {
  setFetchByUrl(() => new Response("[]", { status: 200 }));
  assert.equal(await findPullRequest(PR_LOOKUP), null);
});

test("findPullRequest says to reconnect when GitHub rejects the token", async () => {
  setFetchByUrl(() => new Response("{}", { status: 401 }));
  await assert.rejects(findPullRequest(PR_LOOKUP), GitHubReconnectError);
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

/** What `listGitHubRepositories` throws when GitHub answers `status`. */
async function listingError(status: number): Promise<unknown> {
  setFetchByUrl(() => new Response('{"message":"Bad credentials"}', { status }));
  return listGitHubRepositories("t").then(
    () => assert.fail("expected the listing to fail"),
    (error: unknown) => error,
  );
}

test("a 401 means the token is dead: the route asks the user to reconnect", async () => {
  const error = await listingError(401);
  assert.ok(error instanceof GitHubReconnectError);
  assert.equal(error.status, 401);

  const response = githubErrorResponse(error, "fallback");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Your GitHub connection has expired. Sign out and back in to reconnect.",
    reconnect: true,
  });
});

test("a 403 (rate limit, no access) is not a reconnect: signing in again would not fix it", async () => {
  const error = await listingError(403);
  assert.ok(error instanceof GitHubSyncError);
  assert.ok(!(error instanceof GitHubReconnectError));

  const body = await githubErrorResponse(error, "fallback").json();
  assert.equal(body.reconnect, undefined);
});

test("no stored token also asks the user to reconnect; anything else is the fallback", async () => {
  const missing = githubErrorResponse(new MissingGithubTokenError(), "fallback");
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).reconnect, true);

  const other = githubErrorResponse(new Error("db down"), "fallback");
  assert.equal(other.status, 500);
  assert.deepEqual(await other.json(), { error: "fallback" });
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

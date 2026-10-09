import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { liveEnv } from "@/lib/onboarding/live-env";

const user = { name: "Ada Lovelace", login: "ada", avatarUrl: null };
const realFetch = globalThis.fetch;

type Call = { url: string; method: string; body: unknown };

/** Answer each request by URL and method; record them in order. */
function stubFetch(routes: Record<string, (body: unknown) => [number, unknown]>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
    const [status, json] = route(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("outside the Mac app, onboarding knows it is not on the desktop", () => {
  assert.equal(liveEnv(user).desktop, false);
  // The server still refuses a cloud session without the user's Claude.
  assert.equal(liveEnv(user).neevForCloud, false);
});

test("repositories come from GitHub, most recently pushed first", async () => {
  stubFetch({
    "GET /api/github/repositories": () => [
      200,
      {
        repositories: [
          { githubRepoId: 1, fullName: "ada/old", private: false, pushedAt: "2026-01-01T00:00:00Z" },
          { githubRepoId: 2, fullName: "ada/new", private: true, pushedAt: "2026-10-01T00:00:00Z" },
          { githubRepoId: 3, fullName: "ada/never", private: false, pushedAt: null },
        ],
      },
    ],
  });
  const repos = await liveEnv(user).listRepos();
  assert.deepEqual(
    repos.map((r) => [r.id, r.fullName, r.private]),
    [
      ["2", "ada/new", true],
      ["1", "ada/old", false],
      ["3", "ada/never", false],
    ],
  );
});

test("a failed repository listing says why", async () => {
  stubFetch({ "GET /api/github/repositories": () => [409, { error: "Sign out and back in to GitHub." }] });
  await assert.rejects(liveEnv(user).listRepos(), /Sign out and back in/);
});

test("a cloud start connects the chosen repositories, starts on the first, and marks onboarding done", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [
      200,
      { projects: [{ id: "p-7", githubRepoId: 7 }, { id: "p-9", githubRepoId: 9 }] },
    ],
    "POST /api/projects/p-9/workspaces": () => [200, { workspace: { id: "w-1" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  const href = await liveEnv(user).start({
    target: "cloud",
    prompt: "Fix the flaky test",
    repoIds: ["9", "7"],
    model: "claude",
  });
  assert.equal(href, "/workspaces/w-1?prompt=Fix+the+flaky+test");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ["POST /api/projects/sync", "POST /api/projects/p-9/workspaces", "POST /api/onboarding/complete"],
  );
  assert.deepEqual(calls[0].body, { repoIds: [9, 7] });
});

test("a refused cloud start shows the server's reason and leaves onboarding unmarked", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [200, { projects: [{ id: "p-9", githubRepoId: 9 }] }],
    "POST /api/projects/p-9/workspaces": () => [
      409,
      { error: "Connect Claude in Settings before creating a workspace." },
    ],
  });
  await assert.rejects(
    liveEnv(user).start({ target: "cloud", prompt: "Hi", repoIds: ["9"] }),
    /Connect Claude in Settings/,
  );
  assert.ok(!calls.some((c) => c.url === "/api/onboarding/complete"));
});

test("skipping marks onboarding done and goes home", async () => {
  const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await liveEnv(user).skip!(), "/");
  assert.equal(calls.length, 1);
});

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

/** A server without Outrunner's models: cloud sessions need Claude. */
const noModels = { outrunnerModels: false };

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("outside the Mac app, onboarding knows it is not on the desktop", () => {
  assert.equal(liveEnv(user, noModels).desktop, false);
});

test("cloud setup offers to skip Claude only where the server runs Outrunner's models", () => {
  assert.equal(liveEnv(user, { outrunnerModels: true }).outrunnerModels, true);
  // Without an OpenRouter key the server refuses a cloud session without Claude.
  assert.equal(liveEnv(user, noModels).outrunnerModels, false);
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
  const repos = await liveEnv(user, noModels).listRepos();
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
  await assert.rejects(liveEnv(user, noModels).listRepos(), /Sign out and back in/);
});

test("a cloud start connects the chosen repository, starts there, and marks onboarding done", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [
      200,
      { projects: [{ id: "p-7", githubRepoId: 7 }, { id: "p-9", githubRepoId: 9 }] },
    ],
    "POST /api/projects/p-9/workspaces": () => [200, { workspace: { id: "w-1" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  const href = await liveEnv(user, noModels).start({
    target: "cloud",
    prompt: "Fix the flaky test",
    repoId: "9",
    model: "claude",
  });
  assert.equal(href, "/workspaces/w-1?prompt=Fix+the+flaky+test");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ["POST /api/projects/sync", "POST /api/projects/p-9/workspaces", "POST /api/onboarding/complete"],
  );
  assert.deepEqual(calls[0].body, { repoIds: [9] });
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
    liveEnv(user, noModels).start({ target: "cloud", prompt: "Hi", repoId: "9" }),
    /Connect Claude in Settings/,
  );
  assert.ok(!calls.some((c) => c.url === "/api/onboarding/complete"));
});

test("skipping marks onboarding done and goes home", async () => {
  const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await liveEnv(user, noModels).skip!(), "/");
  assert.equal(calls.length, 1);
});

test("onboarding opens the cloud session with no first message", async () => {
  stubFetch({
    "POST /api/projects/sync": () => [200, { projects: [{ id: "p-9", githubRepoId: 9 }] }],
    "POST /api/projects/p-9/workspaces": () => [200, { workspace: { id: "w-2" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  assert.equal(await liveEnv(user, noModels).start({ target: "cloud", repoId: "9" }), "/workspaces/w-2");
});

/** The Mac app's bridge, answering local_status with `loggedIn`; records the
 *  agent requests it relays. */
function fakeMac(loggedIn: boolean | null): { path: string; body: unknown }[] {
  const agent: { path: string; body: unknown }[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "local_status") {
      return { deviceId: "d", root: "/r", agentBundled: true, git: "/g", tmux: "/t", claude: "/c", claudeLoggedIn: loggedIn };
    }
    if (cmd === "local_agent_request") {
      agent.push({ path: String(args?.path), body: args?.body });
      return {};
    }
    throw new Error(`unexpected ${cmd}`);
  };
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: { core: { invoke, Channel: class {} } },
  };
  return agent;
}

const folder = { path: "/Users/ada/app", name: "app", git: true, branch: "main" };
const key = `sk-or-v1-${"a".repeat(64)}`;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

test("a Mac that isn't logged in starts its session on Outrunner's model", async () => {
  const agent = fakeMac(false);
  stubFetch({ "POST /api/outrunner-models/key": () => [200, { key }], "POST /api/onboarding/complete": () => [200, {}] });
  const href = await liveEnv(user, { outrunnerModels: true }).start({ target: "mac", folder });
  const id = agent[0].body && (agent[0].body as { workspaceId: string }).workspaceId;
  assert.equal(href, `/local/${id}`);
  // Created, then put on the model before anything launches it.
  assert.deepEqual(
    agent.map((a) => a.path),
    ["/workspaces", `/workspaces/${id}/model`],
  );
  assert.deepEqual(agent[1].body, { model: "z-ai/glm-5.3", gateway: "openrouter", token: key });
});

test("a logged-in Mac, or a server without Outrunner's models, keeps the Mac's own Claude", async () => {
  stubFetch({ "POST /api/onboarding/complete": () => [200, {}] });
  for (const [loggedIn, outrunnerModels] of [
    [true, true],
    [null, true], // the app can't tell: left to Claude Code, as before
    [false, false],
  ] as const) {
    const agent = fakeMac(loggedIn);
    await liveEnv(user, { outrunnerModels }).start({ target: "mac", folder });
    assert.deepEqual(agent.map((a) => a.path), ["/workspaces"], `loggedIn=${loggedIn} models=${outrunnerModels}`);
  }
});

test("a session that can't get Outrunner's model is removed, not left on a login screen", async () => {
  const agent = fakeMac(false);
  stubFetch({ "POST /api/outrunner-models/key": () => [503, { error: "Outrunner's models are not set up on this server." }] });
  await assert.rejects(
    liveEnv(user, { outrunnerModels: true }).start({ target: "mac", folder }),
    /not set up on this server/,
  );
  const id = (agent[0].body as { workspaceId: string }).workspaceId;
  await new Promise((resolve) => setTimeout(resolve, 0)); // the destroy is fire-and-forget
  assert.deepEqual(agent.map((a) => a.path), ["/workspaces", `/workspaces/${id}/destroy`]);
});

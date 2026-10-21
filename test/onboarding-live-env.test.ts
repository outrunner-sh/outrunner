import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { forgetOutrunnerModels } from "@/lib/desktop/local-runtime";
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

test("finishing connects the picked repositories and goes home, with no session", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [200, { projects: [{ id: "p-7", githubRepoId: 7 }, { id: "p-9", githubRepoId: 9 }] }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  assert.equal(await liveEnv(user, noModels).finish({ target: "cloud", repoIds: ["9", "7"] }), "/");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ["POST /api/projects/sync", "POST /api/onboarding/complete"],
  );
  assert.deepEqual(calls[0].body, { repoIds: [9, 7] });
});

test("finishing toward the import goes there; with nothing picked, nothing is connected", async () => {
  const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await liveEnv(user, noModels).finish({ target: "cloud", repoIds: [], next: "import" }), "/import");
  assert.deepEqual(calls.map((c) => c.url), ["/api/onboarding/complete"]);
});

test("a first session starts in its repository, on the user's Claude when they chose it", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [
      200,
      { projects: [{ id: "p-7", githubRepoId: 7 }, { id: "p-9", githubRepoId: 9 }] },
    ],
    "POST /api/projects/p-9/workspaces": () => [200, { workspace: { id: "w-1" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  const href = await liveEnv(user, noModels).finish({
    target: "cloud",
    repoIds: ["7", "9"],
    session: { repoId: "9", model: "claude", prompt: "Fix the flaky test" },
  });
  assert.equal(href, "/workspaces/w-1?prompt=Fix+the+flaky+test");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ["POST /api/projects/sync", "POST /api/projects/p-9/workspaces", "POST /api/onboarding/complete"],
  );
  // The user's Claude, named: without it the server's default is Outrunner's.
  assert.deepEqual(calls[1].body, { branch: "", provider: "claude", model: "opus" });
});

test("a first session on Outrunner's models names none, leaving the server's default", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [200, { projects: [{ id: "p-9", githubRepoId: 9 }] }],
    "POST /api/projects/p-9/workspaces": () => [200, { workspace: { id: "w-3" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  const href = await liveEnv(user, { outrunnerModels: true }).finish({
    target: "cloud",
    repoIds: ["9"],
    session: { repoId: "9", model: "outrunner" },
  });
  // No first message: the session opens without a query.
  assert.equal(href, "/workspaces/w-3");
  assert.deepEqual(calls[1].body, { branch: "" });
});

test("a session in a repository that wasn't picked is refused before anything is connected", async () => {
  const calls = stubFetch({});
  await assert.rejects(
    liveEnv(user, noModels).finish({ target: "cloud", repoIds: ["7"], session: { repoId: "9", model: "claude" } }),
    /Choose that repository first/,
  );
  assert.equal(calls.length, 0);
});

test("a refused first session shows the server's reason and leaves onboarding unmarked", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [200, { projects: [{ id: "p-9", githubRepoId: 9 }] }],
    "POST /api/projects/p-9/workspaces": () => [
      409,
      { error: "Connect Claude in Settings before creating a workspace." },
    ],
  });
  await assert.rejects(
    liveEnv(user, noModels).finish({ target: "cloud", repoIds: ["9"], session: { repoId: "9", model: "claude" } }),
    /Connect Claude in Settings/,
  );
  assert.ok(!calls.some((c) => c.url === "/api/onboarding/complete"));
});

test("repositories that can't be connected say why, and onboarding stays unfinished", async () => {
  const calls = stubFetch({
    "POST /api/projects/sync": () => [409, { error: "Sign out and back in to GitHub." }],
  });
  await assert.rejects(liveEnv(user, noModels).finish({ target: "cloud", repoIds: ["9"] }), /Sign out and back in/);
  assert.ok(!calls.some((c) => c.url === "/api/onboarding/complete"));
});

test("skipping marks onboarding done and goes home", async () => {
  const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await liveEnv(user, noModels).skip!(), "/");
  assert.equal(calls.length, 1);
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
  forgetOutrunnerModels(); // each test's menu is its own
});

/** A server with Outrunner's models, and a user with no keys of their own. */
const MENU = { outrunner: true, allowance: true, keys: [], available: true };

test("a Mac that isn't logged in starts its session on Outrunner's model", async () => {
  const agent = fakeMac(false);
  const calls = stubFetch({
    "GET /api/outrunner-models": () => [200, MENU],
    "POST /api/outrunner-models/key": () => [200, { key }],
    "POST /api/onboarding/complete": () => [200, {}],
  });
  const href = await liveEnv(user, { outrunnerModels: true }).finish({ target: "mac", folder });
  const id = agent[0].body && (agent[0].body as { workspaceId: string }).workspaceId;
  assert.equal(href, `/local/${id}`);
  // Created, then put on the model before anything launches it.
  assert.deepEqual(
    agent.map((a) => a.path),
    ["/workspaces", `/workspaces/${id}/model`],
  );
  assert.deepEqual(agent[1].body, { model: "z-ai/glm-5.3", gateway: "openrouter", token: key });
  // On Outrunner's key: the menu's default.
  assert.deepEqual(calls.find((c) => c.url === "/api/outrunner-models/key")?.body, { holder: "outrunner" });
});

test("a logged-in Mac, or a server without Outrunner's models, keeps the Mac's own Claude", async () => {
  stubFetch({ "POST /api/onboarding/complete": () => [200, {}] });
  for (const [loggedIn, outrunnerModels] of [
    [true, true],
    [null, true], // the app can't tell: left to Claude Code, as before
    [false, false],
  ] as const) {
    const agent = fakeMac(loggedIn);
    await liveEnv(user, { outrunnerModels }).finish({ target: "mac", folder });
    assert.deepEqual(agent.map((a) => a.path), ["/workspaces"], `loggedIn=${loggedIn} models=${outrunnerModels}`);
  }
});

test("a session that can't get Outrunner's model is removed, not left on a login screen", async () => {
  const agent = fakeMac(false);
  stubFetch({
    "GET /api/outrunner-models": () => [200, MENU],
    "POST /api/outrunner-models/key": () => [503, { error: "Outrunner's models are not set up on this server." }],
  });
  await assert.rejects(
    liveEnv(user, { outrunnerModels: true }).finish({ target: "mac", folder }),
    /not set up on this server/,
  );
  const id = (agent[0].body as { workspaceId: string }).workspaceId;
  await new Promise((resolve) => setTimeout(resolve, 0)); // the destroy is fire-and-forget
  assert.deepEqual(agent.map((a) => a.path), ["/workspaces", `/workspaces/${id}/destroy`]);
});

test("Claude counts as on this Mac only when Claude Code there says it's logged in", async () => {
  // Outside the Mac app there is nothing to ask.
  assert.equal(await liveEnv(user, noModels).claudeOnMac(), false);
  for (const [loggedIn, found] of [
    [true, true],
    [false, false],
    [null, false], // the app can't tell: no sign of Claude
  ] as const) {
    fakeMac(loggedIn);
    assert.equal(await liveEnv(user, noModels).claudeOnMac(), found, `loggedIn=${loggedIn}`);
  }
});

test("a Mac bridge that fails is no sign of Claude", async () => {
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: {
        invoke: async () => {
          throw new Error("bridge down");
        },
        Channel: class {},
      },
    },
  };
  assert.equal(await liveEnv(user, noModels).claudeOnMac(), false);
});

/** A scan with `sessions`, as the Mac app reports one. */
function scanWith(sessions: { source: string; skip?: string }[]) {
  return {
    version: 1,
    scannedAt: "2026-10-21T00:00:00Z",
    sources: [],
    sessions: sessions.map((s, i) => ({
      key: `claude:k${i}`,
      source: s.source,
      agent: "claude",
      sessionId: `s${i}`,
      title: "",
      cwd: "/r",
      checkedOut: true,
      dirty: false,
      unpushed: 0,
      transcript: "/t",
      transcriptBytes: 1,
      ...(s.skip && { skip: { reason: s.skip } }),
    })),
    projects: [],
    config: { items: [], mcpServers: [], plugins: [] },
  };
}

function fakeScan(answer: () => unknown) {
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: {
        invoke: async (cmd: string) => {
          if (cmd === "import_scan") return answer();
          throw new Error(`unexpected ${cmd}`);
        },
        Channel: class {},
      },
    },
  };
}

test("work to import is found on this Mac, counting only what can move", async () => {
  // Outside the Mac app there's nothing to scan.
  assert.equal(await liveEnv(user, noModels).findImports(), null);
  fakeScan(() =>
    scanWith([
      { source: "conductor" },
      { source: "claude-cli" },
      { source: "conductor" },
      { source: "codex-cli", skip: "no-github-remote" },
    ]),
  );
  assert.deepEqual(await liveEnv(user, noModels).findImports(), { sessions: 3, sources: ["conductor", "claude-cli"] });
});

test("a scan that finds only what can't move, or fails, offers no import", async () => {
  fakeScan(() => scanWith([{ source: "conductor", skip: "no-github-remote" }]));
  assert.equal(await liveEnv(user, noModels).findImports(), null);
  fakeScan(() => {
    throw new Error("scan failed");
  });
  assert.equal(await liveEnv(user, noModels).findImports(), null);
  // An answer the web app can't read is no offer either.
  fakeScan(() => ({ version: 2 }));
  assert.equal(await liveEnv(user, noModels).findImports(), null);
});

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
const noModels = { outrunnerModels: false, prices: null };
const withModels = { outrunnerModels: true, prices: null };

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("outside the Mac app, onboarding knows it is not on the desktop", () => {
  assert.equal(liveEnv(user, noModels).desktop, false);
});

test("cloud setup offers to skip Claude only where the server runs Outrunner's models", () => {
  assert.equal(liveEnv(user, withModels).outrunnerModels, true);
  // Without an OpenRouter key the server refuses a cloud session without Claude.
  assert.equal(liveEnv(user, noModels).outrunnerModels, false);
});

test("going on free, or to bring their own models, marks onboarding done and goes there", async () => {
  for (const [next, href] of [
    [{ to: "home" }, "/"],
    [{ to: "providers" }, "/settings/providers"],
  ] as const) {
    const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
    assert.equal(await liveEnv(user, noModels).finish({ target: "cloud", next }), href);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/onboarding/complete"]);
  }
});

/** A browser page, or the Mac app's, whose navigations are recorded. */
function fakePage(desktop: boolean): string[] {
  const assigned: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    ...(desktop && { __RUNTIME_DESKTOP__: true }),
    location: { assign: (url: string) => assigned.push(url) },
  };
  return assigned;
}

test("a plan opens Stripe's checkout, onboarding marked done first", async () => {
  const stripe = "https://checkout.stripe.com/c/pay/cs_test_1";
  for (const [desktop, href] of [
    // The browser page is leaving for Stripe: nowhere else to go.
    [false, null],
    // The Mac app opens Stripe in the browser, and shows Billing meanwhile.
    [true, "/settings/billing"],
  ] as const) {
    const assigned = fakePage(desktop);
    const calls = stubFetch({
      "POST /api/billing/checkout": () => [200, { url: stripe, kind: "checkout" }],
      "POST /api/onboarding/complete": () => [200, { ok: true }],
    });
    const out = await liveEnv(user, noModels).finish({
      target: "cloud",
      next: { to: "plan", plan: "pro", interval: "year" },
    });
    assert.equal(out, href, `desktop=${desktop}`);
    assert.deepEqual(calls.map((c) => c.url), ["/api/billing/checkout", "/api/onboarding/complete"]);
    assert.deepEqual(calls[0].body, { plan: "pro", interval: "year" });
    assert.deepEqual(assigned, [stripe]);
  }
});

test("a checkout that can't start says why and leaves onboarding unfinished", async () => {
  const assigned = fakePage(false);
  const calls = stubFetch({ "POST /api/billing/checkout": () => [502, { error: "Couldn't reach Stripe. Try again in a moment." }] });
  await assert.rejects(
    liveEnv(user, noModels).finish({ target: "cloud", next: { to: "plan", plan: "max", interval: "month" } }),
    /Couldn't reach Stripe/,
  );
  assert.ok(!calls.some((c) => c.url === "/api/onboarding/complete"));
  assert.deepEqual(assigned, []);
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
  const href = await liveEnv(user, withModels).finish({ target: "mac", folder });
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
    await liveEnv(user, { outrunnerModels, prices: null }).finish({ target: "mac", folder });
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
    liveEnv(user, withModels).finish({ target: "mac", folder }),
    /not set up on this server/,
  );
  const id = (agent[0].body as { workspaceId: string }).workspaceId;
  await new Promise((resolve) => setTimeout(resolve, 0)); // the destroy is fire-and-forget
  assert.deepEqual(agent.map((a) => a.path), ["/workspaces", `/workspaces/${id}/destroy`]);
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

test("the Mac's scan is what onboarding offers to import from", async () => {
  // Outside the Mac app there's nothing to scan.
  assert.equal(await liveEnv(user, noModels).findImports(), null);
  fakeScan(() => scanWith([{ source: "conductor" }, { source: "codex-cli", skip: "no-github-remote" }]));
  const scan = await liveEnv(user, noModels).findImports();
  assert.deepEqual(
    scan?.sessions.map((s) => s.source),
    ["conductor", "codex-cli"],
  );
});

test("a scan that fails, or answers what the web app can't read, offers no import", async () => {
  fakeScan(() => {
    throw new Error("scan failed");
  });
  assert.equal(await liveEnv(user, noModels).findImports(), null);
  fakeScan(() => ({ version: 2 }));
  assert.equal(await liveEnv(user, noModels).findImports(), null);
});

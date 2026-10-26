import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { RepositoryListing } from "@/lib/github/listing";
import { firstModel, liveEnv, OnboardingError } from "@/lib/onboarding/live-env";
import { CLI_DEFAULT_URL, connectClaudeCommand, filterRepositories, freeModelsOffer, sortRepositories } from "@/lib/onboarding/rules";
import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";

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

const env = () => liveEnv(user, { outrunnerModels: true });

const statusRoutes = (claude: { connected: boolean; last4: string | null }, keys: Record<string, { connected: boolean }>) => ({
  "GET /api/settings/claude": () => [200, claude] as [number, unknown],
  "GET /api/settings/providers": () => [200, { keys }] as [number, unknown],
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("what's connected is read from Settings' own routes", async () => {
  stubFetch(statusRoutes({ connected: true, last4: "a1b2" }, { anthropic: { connected: false }, openai: { connected: true } }));
  assert.deepEqual(await env().agentStatus(), {
    claude: { subscription: true, last4: "a1b2", apiKey: false },
    codex: { apiKey: true },
  });
});

test("a pasted token and an API key are saved where Settings saves them, then read back", async () => {
  const calls = stubFetch({
    "PUT /api/settings/claude": () => [200, { connected: true, last4: "p4st" }],
    "PUT /api/settings/providers": () => [200, { keys: {} }],
    ...statusRoutes({ connected: true, last4: "p4st" }, { anthropic: { connected: true } }),
  });
  await env().saveClaudeToken("sk-ant-oat01-token");
  await env().saveApiKey("anthropic", "sk-ant-api03-key");
  const writes = calls.filter((c) => c.method === "PUT");
  assert.deepEqual(writes, [
    { url: "/api/settings/claude", method: "PUT", body: { token: "sk-ant-oat01-token" } },
    { url: "/api/settings/providers", method: "PUT", body: { provider: "anthropic", key: "sk-ant-api03-key" } },
  ]);
});

test("picking repositories connects just those, as the repository picker does", async () => {
  const calls = stubFetch({ "POST /api/projects/sync": () => [200, { projects: [{ id: "p1", githubRepoId: 7 }] }] });
  const projects = await env().connect([7]);
  assert.deepEqual(calls[0].body, { repoIds: [7] });
  assert.equal(projects[0].id, "p1");
});

test("starting the first session marks onboarding done and opens the session", async () => {
  const calls = stubFetch({
    "POST /api/projects/p1/workspaces": () => [202, { workspace: { id: "w1" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  assert.equal(await env().startSession("p1", "claude"), "/workspaces/w1");
  assert.deepEqual(calls[0].body, { branch: "", provider: "claude", model: "opus" });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/projects/p1/workspaces", "POST /api/onboarding/complete"]);
});

test("a session refused says why and where to fix it, and onboarding isn't marked done", async () => {
  const calls = stubFetch({
    "POST /api/projects/p1/workspaces": () => [403, { error: "Your plan's 2 sessions are running.", settingsHref: "/upgrade" }],
  });
  await assert.rejects(env().startSession("p1", "outrunner"), (e: unknown) => e instanceof OnboardingError && e.href === "/upgrade");
  assert.equal(calls.some((c) => c.url === "/api/onboarding/complete"), false);
});

test("skipping marks onboarding done and goes home", async () => {
  stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await env().skip(), "/");
});

test("the first session starts on the agent picked: the user's own, or the menu's default", () => {
  assert.deepEqual(firstModel("claude"), { provider: "claude", model: "opus" });
  assert.equal(firstModel("codex").provider, "codex");
  assert.deepEqual(firstModel("outrunner"), {});
});

test("Codex on Outrunner's models starts Codex on Outrunner's first model, not Claude Code", async () => {
  const first = firstModel("codex-outrunner");
  assert.deepEqual(first, { provider: "outrunner", model: OUTRUNNER_MODELS[0].id, agent: "codex" });
  const calls = stubFetch({
    "POST /api/projects/p1/workspaces": () => [202, { workspace: { id: "w1" } }],
    "POST /api/onboarding/complete": () => [200, { ok: true }],
  });
  await env().startSession("p1", "codex-outrunner");
  assert.deepEqual(calls[0].body, { branch: "", provider: "outrunner", model: OUTRUNNER_MODELS[0].id, agent: "codex" });
});

test("Outrunner's models are offered as the Free plan gives them", () => {
  // The Free plan's $5, at 5¢ a credit.
  assert.equal(freeModelsOffer(), "100 free credits");
});

test("the terminal command connects Claude to this app, without opening onboarding again", () => {
  // The app is always named, even the default: OUTRUNNER_URL in the user's shell would win otherwise.
  assert.equal(connectClaudeCommand("npx", CLI_DEFAULT_URL), "npx outrunner@latest --url https://app.outrunner.sh claude");
  assert.equal(connectClaudeCommand("pnpm dlx", "http://localhost:3000"), "pnpm dlx outrunner@latest --url http://localhost:3000 claude");
});

test("repositories show most recently pushed first, and filter by name or description", () => {
  const repo = (fullName: string, pushedAt: string | null, description: string | null = null) =>
    ({ fullName, pushedAt, description }) as RepositoryListing;
  const sorted = sortRepositories([repo("a/old", "2026-01-01"), repo("a/new", "2026-10-01"), repo("a/never", null)]);
  assert.deepEqual(sorted.map((r) => r.fullName), ["a/new", "a/old", "a/never"]);
  const list = [repo("acme/web", null, "Marketing site"), repo("acme/api", null)];
  assert.deepEqual(filterRepositories(list, "MARKET").map((r) => r.fullName), ["acme/web"]);
  assert.equal(filterRepositories(list, "  ").length, 2);
});

test("GitHub's refusal is carried as reconnect, and other errors aren't", async () => {
  stubFetch({ "GET /api/github/repositories": () => [409, { error: "Your GitHub connection has expired.", reconnect: true }] });
  await assert.rejects(env().repositories(), (e: unknown) => e instanceof OnboardingError && e.reconnect);
  stubFetch({ "GET /api/github/repositories": () => [502, { error: "GitHub could not list your repositories." }] });
  await assert.rejects(env().repositories(), (e: unknown) => e instanceof OnboardingError && !e.reconnect);
});

test("a refused onboarding mark is logged, and the session still opens", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  stubFetch({
    "POST /api/projects/p1/workspaces": () => [202, { workspace: { id: "w1" } }],
    "POST /api/onboarding/complete": () => [500, { error: "db down" }],
  });
  assert.equal(await env().startSession("p1", "outrunner"), "/workspaces/w1");
  assert.equal(logged.mock.callCount(), 1);
});

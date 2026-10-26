import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { RepositoryListing } from "@/lib/github/listing";
import { firstModel, liveEnv, OnboardingError } from "@/lib/onboarding/live-env";
import { filterRepositories, freeModelsOffer, sortRepositories } from "@/lib/onboarding/rules";

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

test("Outrunner's models are offered as the Free plan gives them", () => {
  assert.equal(freeModelsOffer(), "$5 free to start");
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
